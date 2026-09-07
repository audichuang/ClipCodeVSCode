import { mount } from 'svelte';
import App from './App.svelte';
import './styles/global.css';

const app = mount(App, { target: document.getElementById('app')! });

/* SNIPCODE-HOOK start: perf — warm Shiki at boot (see src/diff.ts for the
   measurement). Same flash in this panel's CommitDetails and PR diffs, same
   one-time cost. Deferred to idle here, unlike the diff panel: this bundle
   code-splits, so warming fetches a chunk over the webview URI, and the graph's
   own first render must not queue behind it. */
const warmHighlighter = () => { void import('./lib/utils/highlighter').then(m => m.getHighlighter()).catch(() => {}); };
if (typeof requestIdleCallback === 'function') requestIdleCallback(warmHighlighter, { timeout: 2000 });
else setTimeout(warmHighlighter, 0);
/* SNIPCODE-HOOK end */

export default app;
