import { formatConfidence, formatHbar, formatSignal, shortId } from '../lib/format';
import type { StageId, TerminalState } from './reducer';

/**
 * The eight pipeline stages, derived from terminal state. This is the "explain it in 60 seconds" strip:
 * each stage says what it did last, which sponsor it maps to, and whether it ran for real or as a stub.
 */

export type StageStatus =
  /** Ran within the last few seconds: light it up. */
  | 'active'
  /** Has a result from earlier. */
  | 'done'
  /** Waiting on the wearer (pending trade). */
  | 'waiting'
  /** Blocked by safe-stop. */
  | 'blocked'
  /** Nothing yet. */
  | 'idle';

export interface Stage {
  id: StageId;
  step: number;
  label: string;
  /** Sponsor / venue the stage maps to. */
  track: string;
  /** One plain-English sentence for judges. */
  explain: string;
  status: StageStatus;
  /** Latest value (short, monospace). */
  value: string;
  /** Secondary line: id, mode or why it is empty. */
  detail: string;
  /** True when the stage ran with a stub provider instead of the real one. */
  stub: boolean;
}

/** How long a stage stays lit after activity. */
export const ACTIVE_MS = 6000;

const META: Record<StageId, Pick<Stage, 'label' | 'track' | 'explain'>> = {
  news: {
    label: 'News',
    track: 'Data · RSS, CryptoPanic, Polymarket, X',
    explain: 'Ghosty reads news wires, prediction markets and vetted X accounts around the clock.',
  },
  credibility: {
    label: 'Credibility',
    track: 'Ethos',
    explain: 'Each source is weighted by its Ethos reputation score, so a rumour from an unknown account counts for less.',
  },
  brain: {
    label: '0G Brain',
    track: '0G Compute',
    explain: 'The decision runs as an inference call on 0G Compute; every decision carries its 0G request id.',
  },
  alert: {
    label: 'Alert',
    track: 'Pod speaker',
    explain: 'An actionable decision becomes a spoken alert on the pod: what happened and which trade it suggests.',
  },
  confirm: {
    label: 'Confirm',
    track: 'Pod button',
    explain: 'Nothing trades until the wearer presses the one button. No press, no trade.',
  },
  execute: {
    label: 'Execute',
    track: 'Hyperliquid + Uniswap',
    explain: 'Perp legs go to Hyperliquid (gold, oil, stocks, BTC); the spot leg swaps through the Uniswap Trading API.',
  },
  log: {
    label: 'Log',
    track: '0G Storage',
    explain: 'Every decision and its outcome is written as an episode to 0G Storage, with a root hash anyone can check.',
  },
  pay: {
    label: 'Pay',
    track: 'Hedera x402',
    explain: 'The agent pays for its premium signal feed per call with x402 on Hedera, from its own wallet, under a daily cap.',
  },
};

export const STAGE_ORDER: StageId[] = ['news', 'credibility', 'brain', 'alert', 'confirm', 'execute', 'log', 'pay'];

export function stageMeta(id: StageId) {
  return META[id];
}

export function selectStages(state: TerminalState, now: number): Stage[] {
  const snap = state.snapshot;
  const safeStop = snap?.safeStop === true || state.health?.safeStop === true;
  const lit = (id: StageId) => {
    const t = state.stageHits[id];
    return t !== undefined && now - t < ACTIVE_MS;
  };
  const make = (id: StageId, s: Omit<Stage, 'id' | 'step' | 'label' | 'track' | 'explain'>): Stage => ({
    id,
    step: STAGE_ORDER.indexOf(id) + 1,
    ...META[id],
    ...s,
    status: s.status === 'done' && lit(id) ? 'active' : s.status,
  });

  // 1. News
  const top = snap?.news[0];
  const news = make('news', {
    status: top ? 'done' : 'idle',
    value: top ? top.title : 'Waiting for first headline',
    detail: top ? `${top.source}${top.handle ? ` · @${top.handle.replace(/^@/, '')}` : ''} · ${snap?.news.length ?? 0} items` : 'Inject a manual test headline to start',
    stub: false,
  });

  // 2. Credibility: newest headline that carries a score or weight.
  const scored = snap?.news.find((n) => n.credibility || n.weight !== undefined);
  const cred = scored?.credibility;
  const credibility = make('credibility', {
    status: scored ? 'done' : 'idle',
    value: cred
      ? `${cred.level}${cred.score !== null ? ` · ${cred.score}` : ''}`
      : scored?.weight !== undefined
        ? `weight ${scored.weight.toFixed(2)}`
        : 'No scored source yet',
    detail: cred ? `@${cred.handle.replace(/^@/, '')} · weight ${cred.weight.toFixed(2)}` : scored ? 'source table weight' : 'Headlines with an X handle get an Ethos score',
    stub: false,
  });

  // 3. Brain
  const d = snap?.lastDecision;
  const brainStub = state.zeroG?.computeMode === 'fake';
  const brain = make('brain', {
    status: safeStop ? 'blocked' : d ? 'done' : 'idle',
    value: safeStop ? 'Brain offline: trading blocked' : d ? `${formatSignal(d.signal)} · ${formatConfidence(d.confidence)}` : 'No decision yet',
    detail: safeStop
      ? 'Safe-stop engaged. No decision is faked.'
      : d
        ? `req ${shortId(d.requestId, 8, 4)}${brainStub ? ' · stub decider' : ''}`
        : brainStub
          ? 'Stub decider: set OG_API_KEY for 0G Compute'
          : state.zeroG?.computeMode === 'not_configured'
            ? 'Not configured: set OG_API_KEY'
            : 'Runs on the next headline or button press',
    stub: brainStub,
  });

  // 4. Alert
  const alertItem = snap?.alerts[0];
  const alert = make('alert', {
    status: alertItem ? 'done' : 'idle',
    value: alertItem ? `${alertItem.id} · ${alertItem.status}` : 'No alert yet',
    detail: alertItem ? formatSignal(alertItem.signal) : 'Only actionable decisions alert the wearer',
    stub: false,
  });

  // 5. Confirm
  const pending = (snap?.plannedActions.length ?? 0) > 0;
  const lb = state.lastButton?.result;
  const confirm = make('confirm', {
    status: safeStop ? 'blocked' : pending ? 'waiting' : lb ? 'done' : 'idle',
    value: safeStop
      ? 'Blocked by safe-stop'
      : pending
        ? `Awaiting press · ${snap?.plannedActions.length} leg(s)`
        : lb
          ? lb.action === 'confirm'
            ? 'Confirmed'
            : 'Cancelled'
          : 'Nothing pending',
    detail: lb ? `req ${shortId(lb.requestId, 8, 4)}` : 'Confirm / Cancel mirror the pod button',
    stub: false,
  });

  // 6. Execute
  const order = snap?.orders[0];
  const swap = snap?.swaps[0];
  const perpStub = state.execution?.perpMode === 'fake';
  const execute = make('execute', {
    status: safeStop ? 'blocked' : order || swap ? 'done' : 'idle',
    value: order ? `${order.isBuy ? 'Long' : 'Short'} ${order.coin} · ${order.status}` : swap ? `Swap · ${swap.result?.status ?? 'failed'}` : 'No order yet',
    detail: order
      ? `${order.orderId ? `oid ${shortId(order.orderId, 8, 4)}` : order.error ?? ''}${swap ? ` · swap ${swap.result?.status ?? 'failed'}` : ''}`
      : perpStub
        ? 'Simulated venue: set HL_AGENT_PRIVATE_KEY'
        : state.execution?.perpMode === 'not_configured'
          ? 'Not configured: set HL_MASTER_ADDRESS + HL_AGENT_PRIVATE_KEY'
          : 'Hyperliquid perps + Uniswap spot leg',
    stub: perpStub || order?.status === 'simulated',
  });

  // 7. Log
  const ep = snap?.episodes[0];
  const storageStub = state.zeroG?.storageMode === 'memory';
  const storageOff = state.zeroG?.storageMode === 'not_configured';
  const logStage = make('log', {
    status: ep ? 'done' : 'idle',
    value: ep ? `Episode #${ep.seq} · ${ep.outcome}` : 'No episode yet',
    detail: ep
      ? ep.rootHash
        ? `root ${shortId(ep.rootHash, 8, 4)}`
        : storageStub
          ? 'In-memory only: set OG_PRIVATE_KEY'
          : 'Uploading to 0G Storage…'
      : storageStub
        ? 'In-memory log: set OG_PRIVATE_KEY'
        : storageOff
          ? 'Not configured: set OG_PRIVATE_KEY'
          : 'One record per decision',
    stub: storageStub,
  });

  // 8. Pay
  const payment = state.x402?.lastPayment ?? (state.lastPayment ? state.lastPayment.result : null);
  const payStub = state.x402?.mode === 'fake';
  const pay = make('pay', {
    status: payment ? 'done' : 'idle',
    value: payment ? `${formatHbar(payment.amountTinybar ?? null)} paid` : 'No payment yet',
    detail: payment
      ? `tx ${shortId(payment.txId, 10, 6)}${payment.mode === 'fake' ? ' · simulated' : ''}`
      : payStub
        ? 'Simulated payer: set HEDERA_ACCOUNT_ID + key'
        : state.x402?.mode === 'not_configured'
          ? 'Not configured: set HEDERA_ACCOUNT_ID + key'
          : 'Pays /signal per call',
    stub: payStub,
  });

  return [news, credibility, brain, alert, confirm, execute, logStage, pay];
}
