import { mount } from 'svelte';
import Diff from './diff/Diff.svelte';
import { listenForHostMessages } from './diff/messaging';

listenForHostMessages();
mount(Diff, { target: document.getElementById('diff-app')! });
