import { createPublicClient, createWalletClient, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

/**
 * One-time: Permit2.approve(USDC, Uniswap Universal Router, uint160 max, 1 year) from the swap wallet.
 * After it, Uniswap quotes need no permit, so the Dabao signs only the swap transaction for each buy.
 * Key from APPROVE_KEY (never printed). Run on a trusted computer, not on the server.
 */
const key = process.env.APPROVE_KEY?.trim();
if (!key) throw new Error('set APPROVE_KEY');
const account = privateKeyToAccount((key.startsWith('0x') ? key : `0x${key}`) as `0x${string}`);
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const ROUTER = '0xd6145b2D3F379919E8CdEda7B97e37c4b2Ca9c40';
const abi = parseAbi([
  'function approve(address token, address spender, uint160 amount, uint48 expiration)',
  'function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
]);
const pub = createPublicClient({ chain: base, transport: http() });
const wallet = createWalletClient({ chain: base, transport: http(), account });
const expiration = Math.floor(Date.now() / 1000) + 365 * 86400;
const hash = await wallet.writeContract({ address: PERMIT2, abi, functionName: 'approve', args: [USDC, ROUTER, (1n << 160n) - 1n, expiration] });
const receipt = await pub.waitForTransactionReceipt({ hash });
const [amount, exp] = await pub.readContract({ address: PERMIT2, abi, functionName: 'allowance', args: [account.address, USDC, ROUTER] });
console.log(`from ${account.address}\ntx ${hash} (${receipt.status})\nhttps://basescan.org/tx/${hash}\nallowance ${amount === (1n << 160n) - 1n ? 'unlimited' : amount} until ${new Date(Number(exp) * 1000).toISOString()}`);
