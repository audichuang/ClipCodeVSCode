/* SNIPCODE-HOOK start: sidebar commit details — status colour/label lifted out of
   CommitDetails.svelte so the sidebar file list reads the same. Whole file is
   the moved upstream body; upstream has no such module, hence the file-level
   fence. The HC-light branch inside keeps its own C7 fence. */
import { t } from '../i18n/index.svelte';

/**
 * `git diff --name-status` letter → colour/label. Shared by the graph's
 * CommitDetails panel and the Recent Commits sidebar so one commit's file list
 * reads the same on both surfaces.
 */
export function statusColor(s?: string): string {
  /* SNIPCODE-HOOK start: C7 — HC Light is `vscode-high-contrast-light`, treat as light */
  const light = document.body.classList.contains('vscode-light')
    || document.body.classList.contains('vscode-high-contrast-light');
  /* SNIPCODE-HOOK end */
  if (light) {
    switch (s) {
      case 'A': return '#2e7d32';
      case 'M': return '#8a6d3b';
      case 'D': return '#b71c1c';
      case 'R': return '#1565c0';
      case 'C': return '#6a1b9a';
      case 'N': return '#616161';
      default: return 'var(--text-secondary)';
    }
  }
  switch (s) {
    case 'A': return '#4caf50';
    case 'M': return '#e2c08d';
    case 'D': return '#f44336';
    case 'R': return '#2196f3';
    case 'C': return '#9c27b0';
    case 'N': return '#9e9e9e';
    default: return 'var(--text-secondary)';
  }
}

export function statusLabel(s?: string): string {
  switch (s) {
    case 'A': return t('status.added');
    case 'M': return t('status.modified');
    case 'D': return t('status.deleted');
    case 'R': return t('status.renamed');
    case 'C': return t('status.copied');
    case 'U': return t('status.untracked');
    case 'N': return t('details.nestedRepoLabel');
    default: return '';
  }
}
/* SNIPCODE-HOOK end */
