// Placeholder entry — Task 8 replaces this body with `mount(Workbench, …)`.
// Import a CSS file unique to this entry so vite emits a workbench.css chunk
// (cssCodeSplit needs an actual style import per entry; sharing main.ts's
// global.css import here gets deduped into one shared chunk instead of two).
import './styles/workbench.css';

const el = document.getElementById('workbench-app');
if (el) el.textContent = 'Snipcode Commit Workbench (booting…)';
