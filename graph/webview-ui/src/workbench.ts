import { mount } from 'svelte';
import Workbench from './workbench/Workbench.svelte';
import RecentCommits from './workbench/RecentCommits.svelte';
import { listenForHostMessages } from './workbench/messaging';
import './styles/workbench.css';

const target = document.getElementById('workbench-app')!;
if (document.body.dataset.view === 'recent-commits') {
  mount(RecentCommits, { target });
} else {
  listenForHostMessages();
  mount(Workbench, { target });
}
