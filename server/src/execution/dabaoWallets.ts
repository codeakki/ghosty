import { AccountId, Client, Hbar, PublicKey, TokenId, TransactionId, TransferTransaction } from '@hiero-ledger/sdk';
import type { ClientHederaSigner } from '@x402/hedera';
import { createPublicClient, http, type Address, type Hex } from 'viem';
import { chainFor } from '../wallet/account.js';
import type { SendTxArgs, SignTypedDataArgs, SpotWalletClient } from '../wallet/uniswap.js';
import {
  encodeEvmTxRequest,
  encodeHederaRequest,
  encodePermitRequest,
  lowS,
  PERMIT2_ADDRESS,
  signatureFromReply,
  signedEvmTx,
  signedPermit,
  type EvmTxFields,
  type PermitSingleFields,
} from './dabao.js';
import { signerHub, type SignerHub } from './signerHub.js';

/**
 * Wallets whose only signer is the Dabao in the pod (through the signer hub). The server builds the transaction,
 * the Dabao checks it against its own limits and signs it, and the server only submits what came back.
 */

/** Uniswap swaps on Base from the Dabao's address. Native ETH input only: the Dabao signs no Permit2 messages. */
export class DabaoSpotWallet implements SpotWalletClient {
  private readonly client;

  constructor(
    private readonly opts: { address: Address; chainId: number; rpcUrl?: string; hub?: Pick<SignerHub, 'sign'> },
  ) {
    const chain = chainFor(opts.chainId, opts.rpcUrl);
    this.client = createPublicClient({ chain, transport: http(opts.rpcUrl) });
  }

  get address(): Address {
    return this.opts.address;
  }

  async sendTransaction(args: SendTxArgs): Promise<Hex> {
    const [nonce, fees, gas] = await Promise.all([
      this.client.getTransactionCount({ address: this.opts.address, blockTag: 'pending' }),
      this.client.estimateFeesPerGas(),
      args.gas ?? this.client.estimateGas({ account: this.opts.address, to: args.to, data: args.data, value: args.value }),
    ]);
    const tx: EvmTxFields = {
      chainId: this.opts.chainId,
      nonce,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      maxFeePerGas: fees.maxFeePerGas,
      gas,
      to: args.to,
      value: args.value ?? 0n,
      data: args.data ?? '0x',
    };
    const rs = signatureFromReply(await (this.opts.hub ?? signerHub).sign(encodeEvmTxRequest(tx)));
    const raw = await signedEvmTx(tx, rs, this.opts.address);
    return this.client.sendRawTransaction({ serializedTransaction: raw });
  }

  /** Only a Permit2 PermitSingle on this chain; the Dabao checks token, spender, amount and life itself. */
  async signTypedData(args: SignTypedDataArgs): Promise<Hex> {
    const d = args.domain as { name?: string; chainId?: number | string; verifyingContract?: string };
    if (args.primaryType !== 'PermitSingle' || d.name !== 'Permit2' || Number(d.chainId) !== this.opts.chainId || d.verifyingContract?.toLowerCase() !== PERMIT2_ADDRESS.toLowerCase()) {
      throw new Error(`the Dabao signs only Permit2 permits, not ${args.primaryType}`);
    }
    const m = args.message as { details: { token: Address; amount: string; expiration: string; nonce: string }; spender: Address; sigDeadline: string };
    const permit: PermitSingleFields = {
      token: m.details.token,
      amount: BigInt(m.details.amount),
      expiration: Number(m.details.expiration),
      nonce: Number(m.details.nonce),
      spender: m.spender,
      sigDeadline: Number(m.sigDeadline),
    };
    const rs = signatureFromReply(await (this.opts.hub ?? signerHub).sign(encodePermitRequest(permit)));
    return signedPermit(permit, rs, this.opts.address);
  }

  waitForTransactionReceipt(args: { hash: Hex }) {
    return this.client.waitForTransactionReceipt(args);
  }
}

/** One Hedera node per payment, so the transaction has one body and the Dabao signs once. */
const HEDERA_NODE = { testnet: '0.0.3', mainnet: '0.0.3' } as const;

/**
 * x402 payer for Hedera whose key is the Dabao's (an ECDSA secp256k1 account key). Builds the same partially
 * signed TransferTransaction as @x402/hedera's createClientHederaSigner; the facilitator adds the fee payer.
 */
export class DabaoHederaSigner implements ClientHederaSigner {
  readonly accountId: string;
  private readonly publicKey: PublicKey;

  constructor(
    private readonly opts: {
      accountId: string;
      /** Compressed secp256k1 public key, hex. */
      publicKeyHex: string;
      network: 'testnet' | 'mainnet';
      hub?: Pick<SignerHub, 'sign'>;
    },
  ) {
    this.accountId = AccountId.fromString(opts.accountId).toString();
    this.publicKey = PublicKey.fromBytesECDSA(Buffer.from(opts.publicKeyHex.replace(/^0x/i, ''), 'hex'));
  }

  async createPartiallySignedTransferTransaction(requirements: {
    amount: string;
    asset: string;
    payTo: string;
    network: string;
    extra?: Record<string, unknown>;
  }): Promise<string> {
    const feePayer = requirements.extra?.feePayer;
    if (typeof feePayer !== 'string') throw new Error('feePayer is required in paymentRequirements.extra');
    const amount = BigInt(requirements.amount);
    if (amount <= 0n) throw new Error('amount must be greater than zero');
    const me = AccountId.fromString(this.accountId);
    const payTo = AccountId.fromString(requirements.payTo);
    const tx = new TransferTransaction();
    if (requirements.asset === '0.0.0') {
      tx.addHbarTransfer(me, Hbar.fromTinybars((-amount).toString()));
      tx.addHbarTransfer(payTo, Hbar.fromTinybars(amount.toString()));
    } else {
      const token = TokenId.fromString(requirements.asset);
      tx.addTokenTransfer(token, me, -amount);
      tx.addTokenTransfer(token, payTo, amount);
    }
    tx.setTransactionId(TransactionId.generate(AccountId.fromString(feePayer)));
    tx.setNodeAccountIds([AccountId.fromString(HEDERA_NODE[this.opts.network])]);
    const client = this.opts.network === 'mainnet' ? Client.forMainnet() : Client.forTestnet();
    try {
      tx.freezeWith(client);
      await tx.signWith(this.publicKey, async (body) => {
        const rs = lowS(signatureFromReply(await (this.opts.hub ?? signerHub).sign(encodeHederaRequest(body))));
        if (!this.publicKey.verify(body, rs)) throw new Error('Dabao signature does not match HEDERA_DABAO_PUBLIC_KEY');
        return rs;
      });
      return Buffer.from(tx.toBytes()).toString('base64');
    } finally {
      client.close();
    }
  }
}
