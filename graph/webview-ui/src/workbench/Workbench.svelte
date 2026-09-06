<script lang="ts">
  import { workbenchStore } from './workbench-store.svelte';
  import { postCommit, saveDraft, requestAmendPrefill } from './messaging';
  /* SNIPCODE-HOOK start: X1-5 workbench strings through webview i18n */
  import { t } from '../lib/i18n/index.svelte';
  /* SNIPCODE-HOOK end */

  const store = workbenchStore;

  const failures = $derived(store.results.filter((r) => !r.ok));
  const okCount = $derived(store.results.filter((r) => r.ok).length);

  /* SNIPCODE-HOOK start: R6 persist the draft on every edit so a hidden/remounted
     view (retainContextWhenHidden, extension.ts) can restore it via getState() */
  $effect(() => {
    saveDraft(store.message);
  });
  /* SNIPCODE-HOOK end */

  /* SNIPCODE-HOOK start: S13 Amend prefill — empty message fetches HEAD's
     message instead of committing; a non-empty one amends as before. */
  function onAmendClick(): void {
    if (!store.message.trim()) {
      requestAmendPrefill();
    } else {
      postCommit(true);
    }
  }
  /* SNIPCODE-HOOK end */

  /* SNIPCODE-HOOK start: S14 Ctrl/Cmd+Enter commits from the textarea */
  function onTextareaKeydown(e: KeyboardEvent): void {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && store.canCommit) {
      e.preventDefault();
      postCommit(false);
    }
  }
  /* SNIPCODE-HOOK end */
</script>

<div class="commit-box">
  {#if store.commitError}
    <p class="banner error"><span class="codicon codicon-error"></span>{store.commitError}</p>
  {:else if failures.length}
    <p class="banner error"><span class="codicon codicon-error"></span>{failures.map((f) => `${f.repoName}: ${f.error}`).join('；')}</p>
  {:else if okCount > 0}
    <p class="banner ok"><span class="codicon codicon-check"></span>{t('workbench.committedCount', { count: okCount })}</p>
  {/if}

  <textarea
    bind:value={store.message}
    placeholder={t('workbench.messagePlaceholder')}
    rows="3"
    onkeydown={onTextareaKeydown}
  ></textarea>

  <div class="actions">
    <button class="btn primary" disabled={!store.canCommit} onclick={() => postCommit(false)}>
      {#if store.committing}<span class="codicon codicon-loading spin"></span>{:else}<span class="codicon codicon-check"></span>{/if}
      {t('workbench.commit')}
    </button>
    <button
      class="btn secondary"
      disabled={!store.canAmend}
      onclick={onAmendClick}
      title={t('workbench.amendTitle')}
    >
      {t('workbench.amend')}
    </button>
  </div>

  <!-- SNIPCODE-HOOK start: S13 "already pushed" warning for Amend -->
  {#if store.amendTargetPushed}
    <p class="banner warning"><span class="codicon codicon-warning"></span>{t('workbench.amendPushedWarning')}</p>
  {/if}
  <!-- SNIPCODE-HOOK end -->
</div>

<style>
  .commit-box {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground);
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .banner {
    display: flex; align-items: center; gap: 6px;
    margin: 0; padding: 4px 8px; border-radius: 4px; font-size: 11.5px; line-height: 1.35;
  }
  .banner .codicon { font-size: 13px; flex: none; }
  .banner.error { background: var(--vscode-inputValidation-errorBackground, #5a1d1d); }
  .banner.ok { background: var(--vscode-inputValidation-infoBackground, #063b49); }
  .banner.warning { background: var(--vscode-inputValidation-warningBackground, #352a05); }
  textarea {
    width: 100%; box-sizing: border-box; padding: 6px 8px; min-height: 52px;
    font-family: var(--vscode-font-family); font-size: var(--vscode-font-size, 13px);
    background: var(--vscode-input-background); color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent); border-radius: 4px;
    resize: vertical; outline: none;
  }
  textarea::placeholder { color: var(--vscode-input-placeholderForeground); }
  textarea:focus { border-color: var(--vscode-focusBorder); }
  .actions { display: flex; gap: 8px; }
  .btn {
    display: inline-flex; align-items: center; gap: 5px;
    padding: 4px 12px; border: 1px solid transparent; border-radius: 4px;
    font-family: inherit; font-size: 12px; cursor: pointer; white-space: nowrap;
  }
  .btn .codicon { font-size: 14px; }
  .btn.primary { flex: 1; justify-content: center; background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .btn.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  .btn.secondary { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .btn.secondary:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
  .btn:disabled { opacity: 0.4; cursor: default; }
  .btn:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  .spin { animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
