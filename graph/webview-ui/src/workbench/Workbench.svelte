<script lang="ts">
  import { workbenchStore } from './workbench-store.svelte';
  import { postCommit } from './messaging';

  const store = workbenchStore;

  function triClass(state: 'all' | 'some' | 'none'): string {
    return state === 'all' ? 'checked' : state === 'some' ? 'partial' : '';
  }
</script>

<div class="workbench">
  {#if store.repos.length === 0}
    <p class="empty">沒有偵測到未提交的變更。</p>
  {:else}
    {#each store.repos as repo (repo.repoPath)}
      <section class="repo">
        <header class="repo-head">
          <button
            class="collapse"
            aria-label={store.collapsed[repo.repoPath] ? '展開' : '收合'}
            onclick={() => store.toggleCollapse(repo.repoPath)}
          >
            <span class="codicon codicon-chevron-{store.collapsed[repo.repoPath] ? 'right' : 'down'}"></span>
          </button>
          <input
            type="checkbox"
            class={triClass(store.repoTriState(repo.repoPath))}
            checked={store.repoTriState(repo.repoPath) === 'all'}
            indeterminate={store.repoTriState(repo.repoPath) === 'some'}
            disabled={repo.commitDisabledReason != null}
            onchange={() => store.toggleRepo(repo.repoPath)}
          />
          <span class="repo-name">{repo.repoName}</span>
          <span class="count">{repo.files.length} changes</span>
        </header>

        {#if repo.commitDisabledReason}
          <p class="banner error">{repo.commitDisabledReason}</p>
        {:else if repo.detached}
          <p class="banner warn">detached HEAD：此提交不在任何分支上。</p>
        {/if}

        {#if !store.collapsed[repo.repoPath]}
          <ul class="files">
            {#each repo.files as file (file.path)}
              <li class="file-row">
                <input
                  type="checkbox"
                  checked={store.isChecked(repo.repoPath, file.path)}
                  disabled={repo.commitDisabledReason != null}
                  onchange={() => store.toggleFile(repo.repoPath, file.path)}
                />
                <span class="badge badge-{file.changeType}">{file.changeType}</span>
                <span class="path">{file.path}</span>
                {#if file.hunkable}
                  <span class="hunks">{file.hunkCount} hunk{file.hunkCount === 1 ? '' : 's'}</span>
                {:else}
                  <span class="hunks whole">整檔</span>
                {/if}
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    {/each}
  {/if}

  <div class="commit-box">
    <textarea
      bind:value={store.message}
      placeholder="commit message（共用一個，繁中）"
      rows="3"
    ></textarea>
    <div class="actions">
      <button disabled={!store.canCommit || store.message.trim() === '' || store.committing}
              onclick={() => postCommit(false)}>
        Commit 勾選的變更
      </button>
      <button disabled={!store.canAmend || store.message.trim() === '' || store.committing}
              onclick={() => postCommit(true)}
              title={store.canAmend ? '' : '只能勾選單一 repo 時使用 Amend'}>
        Amend
      </button>
    </div>
  </div>
</div>

<style>
  .workbench { font-family: var(--vscode-font-family); color: var(--vscode-foreground); font-size: 12px; padding: 4px; }
  .empty { opacity: 0.7; padding: 8px; }
  .repo-head { display: flex; align-items: center; gap: 4px; padding: 2px 0; }
  .repo-name { font-weight: 600; }
  .count { opacity: 0.6; margin-left: auto; }
  .banner { margin: 2px 0 4px 20px; padding: 4px 6px; border-radius: 3px; font-size: 11px; }
  .banner.error { background: var(--vscode-inputValidation-errorBackground); }
  .banner.warn { background: var(--vscode-inputValidation-warningBackground); }
  .files { list-style: none; margin: 0; padding: 0 0 0 20px; }
  .file-row { display: flex; align-items: center; gap: 6px; padding: 1px 0; }
  .badge { font-weight: 700; width: 1.2em; text-align: center; }
  .badge-M { color: var(--vscode-gitDecoration-modifiedResourceForeground); }
  .badge-A { color: var(--vscode-gitDecoration-addedResourceForeground); }
  .badge-D { color: var(--vscode-gitDecoration-deletedResourceForeground); }
  .path { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .hunks { opacity: 0.6; font-size: 11px; }
  .collapse { background: none; border: none; color: inherit; cursor: pointer; padding: 0; }
  .commit-box { border-top: 1px solid var(--vscode-panel-border); margin-top: 6px; padding-top: 6px; }
  textarea { width: 100%; box-sizing: border-box; background: var(--vscode-input-background);
    color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); resize: vertical; }
  .actions { display: flex; gap: 6px; margin-top: 6px; }
  .actions button { background: var(--vscode-button-background); color: var(--vscode-button-foreground);
    border: none; padding: 4px 10px; cursor: pointer; }
  .actions button:disabled { opacity: 0.5; cursor: default; }
</style>
