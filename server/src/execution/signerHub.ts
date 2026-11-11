import { randomUUID } from 'node:crypto';

/**
 * Hands sign requests to the pod and the Dabao's reply back. Every signature (Hyperliquid orders, Uniswap swaps,
 * Hedera x402 payments) goes through here: the server holds no key for them.
 *
 * One pod, one request at a time; later requests wait in line. The pod picks a request up in two ways:
 *  - during a voice turn: /voice (or /sign) answers 202 + the frame;
 *  - between turns: GET /sign/next, which the pod calls while it is idle (payments and swaps the agent starts itself).
 * The pod relays the frame over UART to the Dabao and POSTs the reply frame to /sign.
 */

export const SIGN_TIMEOUT_MS = 45_000;
/** A pod that asked for work within this time counts as connected. It asks at least every idle cycle (~15 s). */
export const POD_SEEN_MS = 60_000;

export interface SignRequest {
  id: string;
  /** Frame for the Dabao, relayed byte for byte. */
  frame: Buffer;
}

export class SignerUnavailableError extends Error {
  override readonly name = 'SignerUnavailableError';
}

interface Pending {
  id: string;
  frame: Buffer;
  /** True once a pod has taken it. */
  taken: boolean;
  resolve: (reply: Buffer) => void;
  reject: (err: Error) => void;
  timer?: NodeJS.Timeout;
}

export class SignerHub {
  private pending: Pending | undefined;
  private readonly queue: Pending[] = [];
  private readonly waiters = new Set<(req: SignRequest) => void>();
  private lastPodMs = 0;

  constructor(
    private readonly timeoutMs = SIGN_TIMEOUT_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** True when a pod is waiting now or asked for work recently. */
  get podConnected(): boolean {
    return this.waiters.size > 0 || (this.lastPodMs > 0 && this.now() - this.lastPodMs < POD_SEEN_MS);
  }

  /** Send `frame` to the pod's signer and wait for its reply frame. Waits in line behind earlier requests. */
  sign(frame: Buffer): Promise<Buffer> {
    if (!this.podConnected) return Promise.reject(new SignerUnavailableError('no pod is connected to relay the signature'));
    return new Promise<Buffer>((resolve, reject) => {
      this.queue.push({ id: randomUUID(), frame, taken: false, resolve, reject });
      this.advance();
    });
  }

  /** True while a request is waiting for the pod or the Dabao. */
  get busy(): boolean {
    return this.pending !== undefined;
  }

  private advance(): void {
    if (this.pending) return;
    const next = this.queue.shift();
    if (!next) return;
    this.pending = next;
    next.timer = setTimeout(() => {
      if (this.pending !== next) return;
      this.pending = undefined;
      next.reject(new SignerUnavailableError(next.taken ? 'the signer did not answer in time' : 'no pod picked up the sign request'));
      this.advance();
    }, this.timeoutMs);
    next.timer.unref?.();
    this.offer();
  }

  private offer(): void {
    const p = this.pending;
    if (!p || p.taken || this.waiters.size === 0) return;
    p.taken = true;
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const w of waiters) w({ id: p.id, frame: p.frame });
  }

  /** Route side: the next sign request for the pod. Call cancel() when the pod's request ends. */
  nextRequest(): { promise: Promise<SignRequest>; cancel: () => void } {
    this.lastPodMs = this.now();
    let waiter!: (req: SignRequest) => void;
    const promise = new Promise<SignRequest>((resolve) => {
      waiter = resolve;
      this.waiters.add(waiter);
    });
    this.offer();
    return { promise, cancel: () => this.waiters.delete(waiter) };
  }

  /** Route side: the pod's reply for request `id`. False if it is unknown or expired. */
  deliver(id: string, reply: Buffer): boolean {
    const p = this.pending;
    if (!p || p.id !== id) return false;
    clearTimeout(p.timer);
    this.pending = undefined;
    p.resolve(reply);
    this.advance();
    return true;
  }
}

/** The pod's signer, shared by the venue, the swap wallet, the x402 payer and the /voice, /sign routes. */
export const signerHub = new SignerHub();
