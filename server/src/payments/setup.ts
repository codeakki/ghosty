/**
 * The custody split, as a plan you can re-run. `npm run hedera:setup` (src/scripts/hederaSetup.ts) wires real
 * Hedera operations into `runSetup`; tests wire fakes. Each step checks first and acts only when something is
 * missing, so a second run changes nothing.
 *
 *   TREASURY (cold, big balance) ──funds──▶ AGENT (hot, ~20 HBAR + ~5 USDC) ──x402──▶ MERCHANT (Signal Desk)
 *   HCS topic: admin key = treasury, submit key = dedicated HCS key, fees paid by the agent.
 */

/** Top the agent up to TARGET when it falls below MIN. */
export const AGENT_TARGET_TINYBAR = 20n * 100_000_000n; // 20 HBAR
export const AGENT_MIN_TINYBAR = 10n * 100_000_000n; // 10 HBAR
export const AGENT_TARGET_USDC_MICROS = 5_000_000n; // 5 USDC
export const AGENT_MIN_USDC_MICROS = 1_000_000n; // 1 USDC

export interface AgentState {
  id: string;
  tinybar: bigint;
  /** undefined = not associated with USDC yet. */
  usdcMicros: bigint | undefined;
}

/** What setup needs from Hedera. Every write is paid by the treasury unless noted. */
export interface SetupOps {
  /** The agent account from env + mirror node, or undefined when there is none yet. */
  agent(): Promise<AgentState | undefined>;
  /** Create an ECDSA account funded from the treasury; store its id and key in .env. Returns the id. */
  createAgent(initialTinybar: bigint): Promise<string>;
  /** TokenAssociateTransaction for USDC, signed by the account's own key. Returns the tx id. */
  associateUsdc(who: 'agent' | 'merchant'): Promise<string>;
  merchantUsdcAssociated(): Promise<boolean>;
  transferHbar(to: string, tinybar: bigint): Promise<string>;
  transferUsdc(to: string, micros: bigint): Promise<string>;
  hasHcsSubmitKey(): boolean;
  /** Generate a fresh ECDSA key (no account, holds nothing) and store it in .env. */
  createHcsSubmitKey(): void;
  topicId(): string | undefined;
  /** TopicCreateTransaction (admin = treasury, submit = HCS key); store the id in .env. Returns it. */
  createTopic(): Promise<string>;
}

export interface SetupStep {
  step: string;
  /** What happened: a tx id, an account/topic id, or "ok" when nothing was needed. */
  result: string;
  changed: boolean;
}

export async function runSetup(ops: SetupOps, log: (s: SetupStep) => void = () => {}): Promise<SetupStep[]> {
  const steps: SetupStep[] = [];
  const done = (step: string, result: string, changed: boolean) => {
    const s = { step, result, changed };
    steps.push(s);
    log(s);
  };

  let agent = await ops.agent();
  if (!agent) {
    const id = await ops.createAgent(AGENT_TARGET_TINYBAR);
    agent = { id, tinybar: AGENT_TARGET_TINYBAR, usdcMicros: undefined };
    done('create agent account', id, true);
  } else {
    done('agent account', agent.id, false);
  }

  if (agent.usdcMicros === undefined) {
    done('associate agent with USDC', await ops.associateUsdc('agent'), true);
    agent.usdcMicros = 0n;
  } else {
    done('agent USDC association', 'ok', false);
  }

  if (agent.tinybar < AGENT_MIN_TINYBAR) {
    done('top up agent HBAR', await ops.transferHbar(agent.id, AGENT_TARGET_TINYBAR - agent.tinybar), true);
  } else {
    done('agent HBAR balance', 'ok', false);
  }

  if (agent.usdcMicros < AGENT_MIN_USDC_MICROS) {
    done('top up agent USDC', await ops.transferUsdc(agent.id, AGENT_TARGET_USDC_MICROS - agent.usdcMicros), true);
  } else {
    done('agent USDC balance', 'ok', false);
  }

  if (!(await ops.merchantUsdcAssociated())) {
    done('associate merchant with USDC', await ops.associateUsdc('merchant'), true);
  } else {
    done('merchant USDC association', 'ok', false);
  }

  if (!ops.hasHcsSubmitKey()) {
    ops.createHcsSubmitKey();
    done('create HCS submit key', 'HEDERA_HCS_SUBMIT_KEY', true);
  } else {
    done('HCS submit key', 'ok', false);
  }

  const topic = ops.topicId();
  if (!topic) {
    done('create HCS audit topic', await ops.createTopic(), true);
  } else {
    done('HCS audit topic', topic, false);
  }
  return steps;
}
