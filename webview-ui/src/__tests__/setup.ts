// vitest setup for the webview project. Runs before every webview test file.
//
// The webview production code calls `acquireVsCodeApi()` — a global injected
// by the VS Code webview host. In a jsdom/happy-dom test environment that
// global doesn't exist, so any module that imports `vscode-api.ts` (most of
// the modals do) blows up at module-eval time. We install a recording stub
// so tests can both render those components and inspect the messages they
// send back to the extension.

interface PostedMessage { data: unknown; }
declare global {
  // eslint-disable-next-line no-var
  var __postedMessages: PostedMessage[];
  function acquireVsCodeApi(): { postMessage(msg: unknown): void; getState(): unknown; setState(s: unknown): void };
}

globalThis.__postedMessages = [];

(globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
  postMessage(msg: unknown) {
    globalThis.__postedMessages.push({ data: msg });
  },
  getState() { return undefined; },
  setState(_s: unknown) { /* noop */ },
});

// happy-dom does not implement the Web Animations API. Svelte 5's compiled
// transition runtime calls element.animate() unconditionally on mount/destroy
// of any element inside an {#if} block, which surfaces as "Unhandled Errors"
// in CI (Node 22) even when all test assertions pass. The errors are benign
// in a test environment — we only need a no-op stub that returns an object
// with the bits Svelte reads (cancel, finished, onfinish).
if (typeof Element !== 'undefined' && typeof Element.prototype.animate !== 'function') {
  (Element.prototype as unknown as { animate: () => unknown }).animate = function () {
    return {
      cancel() {},
      finish() {},
      pause() {},
      play() {},
      reverse() {},
      addEventListener() {},
      removeEventListener() {},
      finished: Promise.resolve(),
      onfinish: null,
      oncancel: null,
      currentTime: 0,
      playbackRate: 1,
    };
  };
}

// Each test gets a fresh outbox so assertions don't see leftovers from a
// previous file's setup. Use `globalThis` rather than module-scope so the
// helper survives the cross-file boundary vitest puts between tests.
import { beforeEach } from 'vitest';
beforeEach(() => {
  globalThis.__postedMessages = [];
});

export {};
