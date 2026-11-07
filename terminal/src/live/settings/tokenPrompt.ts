import { saveSettings, type ClientSettings, type UnauthorizedInfo } from '../../api/client';

/**
 * When to ask for the device token. Any 401 shows the calm banner under the header. The Settings dialog opens by
 * itself at most once per browser session, and only for a 401 caused by something the user did (every user action
 * is a POST; background polls are GETs), never from polling.
 */
export interface TokenPromptState {
  /** A guarded route answered 401 since the last save. */
  needsToken: boolean;
  /** The Settings dialog is open. */
  open: boolean;
  /** The dialog already opened by itself this session. */
  autoOpened: boolean;
}

export type TokenPromptEvent =
  | { type: 'unauthorized'; info: UnauthorizedInfo }
  | { type: 'open' }
  | { type: 'close' }
  | { type: 'saved' };

export const AUTO_OPENED_KEY = 'ghosty.live.tokenPromptShown.v1';

export function isUserAction(info: UnauthorizedInfo): boolean {
  return info.method === 'POST';
}

export function initialTokenPrompt(storage: Pick<Storage, 'getItem'> | undefined = safeSessionStorage()): TokenPromptState {
  let autoOpened = false;
  try {
    autoOpened = storage?.getItem(AUTO_OPENED_KEY) === '1';
  } catch {
    // Blocked storage: the once-per-session flag lives in memory only.
  }
  return { needsToken: false, open: false, autoOpened };
}

export function tokenPromptReducer(state: TokenPromptState, event: TokenPromptEvent): TokenPromptState {
  switch (event.type) {
    case 'unauthorized': {
      const autoOpen = !state.open && !state.autoOpened && isUserAction(event.info);
      if (state.needsToken && !autoOpen) return state;
      return { ...state, needsToken: true, open: state.open || autoOpen, autoOpened: state.autoOpened || autoOpen };
    }
    case 'open':
      return state.open ? state : { ...state, open: true };
    case 'close':
      return state.open ? { ...state, open: false } : state;
    case 'saved':
      // Optimistic: the next 401 (a wrong token) brings the banner back, but never re-opens the dialog by itself.
      return { ...state, needsToken: false, open: false };
  }
}

/** Persist, then hand the new settings to the Live view. Its state change rebuilds the client, so SSE reconnects. */
export function commitSettings(next: ClientSettings, apply: (s: ClientSettings) => void): void {
  saveSettings(next);
  apply(next);
}

export function rememberAutoOpened(storage: Pick<Storage, 'setItem'> | undefined = safeSessionStorage()): void {
  try {
    storage?.setItem(AUTO_OPENED_KEY, '1');
  } catch {
    // Blocked storage: the in-memory flag still holds for this page.
  }
}

function safeSessionStorage(): Storage | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}
