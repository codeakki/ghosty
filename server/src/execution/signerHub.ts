import { randomUUID } from 'node:crypto';

/**
 * Hands sign requests from the venue to the pod and the Dabao's reply back (HL_SIGNER=dabao).
 *
 * One pod, one request at a time. A voice turn that wants to sign answers the pod's /voice with 202 + the request
 * frame; the pod relays it over UART to the Dabao and POSTs the reply frame to /sign, which resumes the same turn.
 */

export const SIGN_TIMEOUT_MS = 45_000;

export interface SignRequest {
  id: string;
  /** Frame for the Dabao, relayed byte for byte. */
  frame: Buffer;
}

export class SignerUnavailableError extends Error {
  override readonly name = 'SignerUnavailableError';
}

export class SignerHub {
  private pending: { id: string; resolve: (reply: Buffer) => void; reject: (err: Error) => void; timer: NodeJS.Timeout } | undefined;
  private readonly waiters = new Set<(req: SignRequest) => void>();

  constructor(private readonly timeoutMs = SIGN_TIMEOUT_MS) {}

  /** Venue side: send `frame` to the pod's signer and wait for its reply frame. */
  sign(frame: Buffer): Promise<Buffer> {
    if (this.pending) return Promise.reject(new SignerUnavailableError('the signer is busy with another order'));
    if (this.waiters.size === 0) return Promise.reject(new SignerUnavailableError('no pod is connected to relay the signature'));
    const id = randomUUID();
    return new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending = undefined;
        reject(new SignerUnavailableError('the signer did not answer in time'));
      }, this.timeoutMs);
      this.pending = { id, resolve, reject, timer };
      const waiters = [...this.waiters];
      this.waiters.clear();
      for (const w of waiters) w({ id, frame });
    });
  }

  /** Route side: the next sign request, while this pod turn is open. Call cancel() when the turn ends. */
  nextRequest(): { promise: Promise<SignRequest>; cancel: () => void } {
    let waiter!: (req: SignRequest) => void;
    const promise = new Promise<SignRequest>((resolve) => {
      waiter = resolve;
      this.waiters.add(waiter);
    });
    return { promise, cancel: () => this.waiters.delete(waiter) };
  }

  /** Route side: the pod's reply for request `id`. False if it is unknown or expired. */
  deliver(id: string, reply: Buffer): boolean {
    const p = this.pending;
    if (!p || p.id !== id) return false;
    clearTimeout(p.timer);
    this.pending = undefined;
    p.resolve(reply);
    return true;
  }
}

/** The pod's signer, shared by the venue (sign) and the /voice and /sign routes (relay). */
export const signerHub = new SignerHub();
