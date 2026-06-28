import { getVsCodeApi } from '../vscode-api';

let counter = 0;
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * Issues a `checkDirty` request and resolves with the dirty state of the working tree.
 * Each call gets a unique request ID so concurrent in-flight requests don't interfere
 * with each other (e.g., rapid successive checkout clicks).
 */
export function requestDirtyState(): Promise<boolean> {
  const vscode = getVsCodeApi();
  const requestId = `dirty-${++counter}-${Date.now()}`;

  return new Promise<boolean>((resolve, reject) => {
    let settled = false;
    const handler = (event: MessageEvent) => {
      if (event.data?.type !== 'dirtyState') return;
      if (event.data.payload?.requestId !== requestId) return;
      if (settled) return;
      settled = true;
      window.removeEventListener('message', handler);
      clearTimeout(timer);
      resolve(Boolean(event.data.payload.dirty));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', handler);
      reject(new Error('checkDirty timed out'));
    }, REQUEST_TIMEOUT_MS);
    window.addEventListener('message', handler);
    vscode.postMessage({ type: 'checkDirty', payload: { requestId } });
  });
}
