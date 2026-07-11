import { mount } from 'svelte';
import Workbench from './workbench/Workbench.svelte';
import { listenForHostMessages } from './workbench/messaging';
import './styles/workbench.css';

listenForHostMessages();
mount(Workbench, { target: document.getElementById('workbench-app')! });
