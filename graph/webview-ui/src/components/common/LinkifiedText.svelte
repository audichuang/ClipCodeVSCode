<script lang="ts">
  import { linkify } from '../../lib/linkify';
  import { commitLinkRulesStore } from '../../lib/stores/commit-link-rules.svelte';
  import { getVsCodeApi } from '../../lib/vscode-api';
  import { t } from '../../lib/i18n/index.svelte';
  import { tooltip } from '../../lib/actions/tooltip';

  const { text }: { text: string } = $props();
  const vscode = getVsCodeApi();

  const segments = $derived(linkify(text, commitLinkRulesStore.rules));

  function open(e: MouseEvent, url: string) {
    e.preventDefault();
    e.stopPropagation();
    vscode.postMessage({ type: 'openExternalUrl', payload: { url } });
  }
</script>

{#each segments as seg}{#if 'url' in seg}<a
      class="commit-link"
      href={seg.url}
      use:tooltip={t('graph.openLink')}
      onclick={(e) => open(e, seg.url)}
    >{seg.text}</a>{:else}{seg.text}{/if}{/each}

<style>
  .commit-link {
    color: var(--vscode-textLink-foreground);
    text-decoration: none;
    cursor: pointer;
  }
  .commit-link:hover {
    text-decoration: underline;
    color: var(--vscode-textLink-activeForeground);
  }
  /* Suppress the focus outline left after a mouse click; keep it for keyboard navigation. */
  .commit-link:focus {
    outline: none;
  }
  .commit-link:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: 1px;
    border-radius: 2px;
  }
</style>
