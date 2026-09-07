import { mount } from 'svelte';
import './styles/global.css';
import Diff from './diff/Diff.svelte';
import { listenForHostMessages } from './diff/messaging';
import { getVsCodeApi } from './lib/vscode-api';
/* SNIPCODE-HOOK start: perf — warm Shiki at boot, not on the first file. */
import { getHighlighter, detectLanguage, warmLanguage } from './lib/utils/highlighter';
/* SNIPCODE-HOOK end */

listenForHostMessages();
mount(Diff, { target: document.getElementById('diff-app')! });
// Handshake: tell the host the listener is installed. DiffPanel withholds the
// first `diffShow`/`setLocale` until it sees this, so a post that races the
// webview's boot can no longer be silently dropped.
getVsCodeApi().postMessage({ type: 'diffReady' });

/* SNIPCODE-HOOK start: perf — warm Shiki at boot, not on the first file.
   Measured on the production bundle (480-line java diff, headless Chrome):
   diffShow -> every line coloured was 144ms COLD, and `firstLit === allLit`,
   so the panel painted plain text and repainted it coloured 144ms later — a
   visible flash, which is what reads as lag next to a native editor. Almost
   all of it is this one-time engine + theme load, not tokenising (~30ms for
   480 lines). Nothing competes with it here: the panel has no diff to render
   until the host answers the `diffReady` above, which costs a round-trip plus
   its five git invocations. The promise is memoized, so the first file then
   finds it resolved and only pays its grammar.
   `.catch` is required, not defensive: getHighlighter() rejects on a host CSP
   without 'wasm-unsafe-eval', and an unhandled rejection at boot is a console
   error on a panel that otherwise degrades to plain text perfectly well. */
void getHighlighter().catch(() => {});
/* SNIPCODE-HOOK end */

/* SNIPCODE-HOOK start: perf — warm the file's GRAMMAR while the host runs git.
   The engine above is language-agnostic; each grammar still compiles its
   regexes lazily on first use, on the critical path of the first coloured
   frame (java ~10ms, typescript ~20ms). On navigation DiffPanel posts
   `diffLoading` (with the file name) BEFORE its two git invocations and only
   then `diffShow`, so the compile can overlap git instead of following it.
   Its own listener, not a messaging.ts case: this is a hint, never state —
   nothing may depend on it having run. */
window.addEventListener('message', (e: MessageEvent) => {
  const msg = e.data;
  if (msg?.type !== 'diffLoading') return;
  const file = msg.payload?.file;
  if (typeof file === 'string') void warmLanguage(detectLanguage(file));
});
/* SNIPCODE-HOOK end */
