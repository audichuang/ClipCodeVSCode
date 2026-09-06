import { mount } from 'svelte';
import './styles/global.css';
import Diff from './diff/Diff.svelte';
import { listenForHostMessages } from './diff/messaging';
import { getVsCodeApi } from './lib/vscode-api';

listenForHostMessages();
mount(Diff, { target: document.getElementById('diff-app')! });
// Handshake: tell the host the listener is installed. DiffPanel withholds the
// first `diffShow`/`setLocale` until it sees this, so a post that races the
// webview's boot can no longer be silently dropped.
getVsCodeApi().postMessage({ type: 'diffReady' });
