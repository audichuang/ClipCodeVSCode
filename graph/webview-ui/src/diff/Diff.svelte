<script lang="ts">
  import { diffStore } from './diff-store.svelte';
  import { postStageHunks } from './messaging';

  const store = diffStore;
</script>

<div class="diff-view">
  {#if store.hunks.length === 0}
    <p class="empty">點左側 Changes 的檔案以檢視 diff。</p>
  {:else}
    <div class="header">
      <span class="codicon codicon-diff-single"></span>
      <span class="file" title={store.file}>{store.file}</span>
      <span class="side {store.side}">{store.side === 'staged' ? 'Staged' : 'Unstaged'}</span>
    </div>

    {#if store.error}
      <p class="banner error"><span class="codicon codicon-error"></span>{store.error}</p>
    {/if}

    <div class="toolbar">
      <button class="link" onclick={() => store.selectAll()}>全選</button>
      <button class="link" onclick={() => store.clear()}>清空</button>
      <button class="btn primary" disabled={!store.canApply} onclick={() => postStageHunks()}>
        {#if store.busy}<span class="codicon codicon-loading spin"></span>{/if}
        {store.actionLabel}
      </button>
    </div>

    <div class="hunks">
      {#each store.hunks as hunk, i (i)}
        <div class="hunk">
          <label class="hunk-head">
            <input type="checkbox" checked={store.checked.has(i)} onchange={() => store.toggle(i)} />
            <span class="hunk-header">{hunk.header}</span>
          </label>
          <div class="lines">
            {#each hunk.lines as line}
              <div class="line {line.type}">{line.content}</div>
            {/each}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .diff-view {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--vscode-editor-font-size, 12px);
    color: var(--vscode-foreground);
    display: flex;
    flex-direction: column;
    height: 100%;
  }
  .empty { padding: 12px; color: var(--vscode-descriptionForeground); font-family: var(--vscode-font-family); }
  .header {
    display: flex; align-items: center; gap: 6px;
    padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border, transparent);
    font-family: var(--vscode-font-family);
  }
  .header .file { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .header .side {
    margin-left: auto; font-size: 10px; padding: 1px 6px; border-radius: 8px;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  }
  .banner {
    display: flex; align-items: center; gap: 6px; margin: 6px 8px; padding: 4px 8px;
    border-radius: 4px; font-size: 11.5px; font-family: var(--vscode-font-family);
    background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
  }
  .toolbar {
    display: flex; align-items: center; gap: 8px; padding: 6px 8px;
    font-family: var(--vscode-font-family);
  }
  .toolbar .link {
    background: none; border: none; color: var(--vscode-textLink-foreground);
    cursor: pointer; font-size: 12px; padding: 0;
  }
  .toolbar .link:hover { text-decoration: underline; }
  .btn {
    margin-left: auto; display: inline-flex; align-items: center; gap: 5px;
    padding: 4px 12px; border: 1px solid transparent; border-radius: 4px;
    font-size: 12px; cursor: pointer; white-space: nowrap;
    font-family: var(--vscode-font-family);
  }
  .btn.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .btn.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  .btn:disabled { opacity: 0.4; cursor: default; }
  .hunks { overflow: auto; flex: 1; }
  .hunk { border-top: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2)); }
  .hunk-head {
    display: flex; align-items: center; gap: 8px; padding: 4px 8px; cursor: pointer;
    background: var(--vscode-editor-lineHighlightBackground, rgba(128,128,128,0.08));
  }
  .hunk-header { color: var(--vscode-descriptionForeground); }
  .lines { white-space: pre; overflow-x: auto; }
  .line { padding: 0 8px; }
  .line.add { background: var(--vscode-diffEditor-insertedTextBackground, rgba(70,149,74,0.25)); }
  .line.delete { background: var(--vscode-diffEditor-removedTextBackground, rgba(200,60,60,0.25)); }
  .spin { animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
