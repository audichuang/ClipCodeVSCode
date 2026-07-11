<script lang="ts">
  import { workbenchStore } from './workbench-store.svelte';
  import { postCommit } from './messaging';

  const store = workbenchStore;

  function triClass(state: 'all' | 'some' | 'none'): string {
    return state === 'all' ? 'checked' : state === 'some' ? 'partial' : '';
  }

  // Split "src/foo/bar.ts" → dir "src/foo/", base "bar.ts" so the filename can
  // read at full strength with the directory dimmed (VS Code SCM convention).
  function splitPath(p: string): { dir: string; base: string } {
    const i = p.lastIndexOf('/');
    return i >= 0 ? { dir: p.slice(0, i + 1), base: p.slice(i + 1) } : { dir: '', base: p };
  }
</script>

<div class="workbench">
  <div class="list">
    {#if store.repos.length === 0}
      <p class="empty">沒有偵測到未提交的變更。</p>
    {:else}
      {#each store.repos as repo (repo.repoPath)}
        <section class="repo">
          <div class="repo-head">
            <button
              class="twisty"
              aria-label={store.collapsed[repo.repoPath] ? '展開' : '收合'}
              onclick={() => store.toggleCollapse(repo.repoPath)}
            >
              <span class="codicon codicon-chevron-{store.collapsed[repo.repoPath] ? 'right' : 'down'}"></span>
            </button>
            <input
              type="checkbox"
              class="chk {triClass(store.repoTriState(repo.repoPath))}"
              checked={store.repoTriState(repo.repoPath) === 'all'}
              indeterminate={store.repoTriState(repo.repoPath) === 'some'}
              disabled={repo.commitDisabledReason != null}
              onchange={() => store.toggleRepo(repo.repoPath)}
            />
            <button class="repo-title" onclick={() => store.toggleCollapse(repo.repoPath)}>
              <span class="repo-name">{repo.repoName}</span>
              <span class="badge-count">{repo.files.length}</span>
            </button>
          </div>

          {#if repo.commitDisabledReason}
            <p class="banner error"><span class="codicon codicon-warning"></span>{repo.commitDisabledReason}</p>
          {:else if repo.detached}
            <p class="banner warn"><span class="codicon codicon-git-commit"></span>detached HEAD — 此提交不在任何分支上。</p>
          {/if}

          {#if !store.collapsed[repo.repoPath]}
            <ul class="files">
              {#each repo.files as file (file.path)}
                {@const p = splitPath(file.path)}
                <li class="file-row" class:disabled={repo.commitDisabledReason != null}>
                  <label class="file-hit">
                    <input
                      type="checkbox"
                      class="chk"
                      checked={store.isChecked(repo.repoPath, file.path)}
                      disabled={repo.commitDisabledReason != null}
                      onchange={() => store.toggleFile(repo.repoPath, file.path)}
                    />
                    <span class="tag tag-{file.changeType}" title={file.changeType}>{file.changeType}</span>
                    <span class="path">
                      <span class="name">{p.base}</span>{#if p.dir}<span class="dir">{p.dir}</span>{/if}
                    </span>
                    <span class="hunks" class:whole={!file.hunkable}>
                      {file.hunkable ? `${file.hunkCount} hunk${file.hunkCount === 1 ? '' : 's'}` : '整檔'}
                    </span>
                  </label>
                </li>
              {/each}
            </ul>
          {/if}
        </section>
      {/each}
    {/if}
  </div>

  <div class="commit-box">
    {#if store.commitError}
      <p class="banner error"><span class="codicon codicon-error"></span>{store.commitError}</p>
    {/if}
    <textarea
      bind:value={store.message}
      placeholder="Commit 訊息（共用一則，繁中）"
      rows="3"
    ></textarea>
    <div class="actions">
      <button
        class="btn primary"
        disabled={!store.canCommit || store.message.trim() === '' || store.committing}
        onclick={() => postCommit(false)}
      >
        {#if store.committing}<span class="codicon codicon-loading spin"></span>{:else}<span class="codicon codicon-check"></span>{/if}
        Commit
      </button>
      <button
        class="btn secondary"
        disabled={!store.canAmend || store.message.trim() === '' || store.committing}
        onclick={() => postCommit(true)}
        title={store.canAmend ? 'Amend 上一個 commit' : '只能勾選單一 repo 時使用 Amend'}
      >
        Amend
      </button>
    </div>
  </div>
</div>

<style>
  .workbench {
    display: flex;
    flex-direction: column;
    height: 100vh;
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size, 13px);
    color: var(--vscode-foreground);
  }

  /* Scrollable change list; commit box stays pinned below it. */
  .list { flex: 1 1 auto; overflow-y: auto; padding: 4px 0 8px; }
  .empty { opacity: 0.6; padding: 12px; text-align: center; }

  .repo { margin-bottom: 2px; }

  /* --- repo group header (like an SCM resource-group header) --- */
  .repo-head { display: flex; align-items: center; height: 24px; padding: 0 8px; }
  .repo-head:hover { background: var(--vscode-list-hoverBackground); }
  .twisty {
    display: flex; align-items: center; justify-content: center;
    width: 16px; height: 16px; padding: 0; border: none; background: none;
    color: var(--vscode-foreground); opacity: 0.7; cursor: pointer; flex: none;
  }
  .twisty .codicon { font-size: 16px; }
  .repo-title {
    display: flex; align-items: center; gap: 6px; min-width: 0; flex: 1;
    padding: 0; border: none; background: none; color: inherit; cursor: pointer; text-align: left;
  }
  .repo-name {
    font-weight: 600; text-transform: none; letter-spacing: 0.01em;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .badge-count {
    flex: none; min-width: 16px; height: 16px; padding: 0 5px; border-radius: 8px;
    display: inline-flex; align-items: center; justify-content: center;
    font-size: 11px; line-height: 1;
    background: var(--vscode-badge-background); color: var(--vscode-badge-foreground);
  }

  /* --- file rows --- */
  .files { list-style: none; margin: 0; padding: 0; }
  .file-row { height: 22px; }
  .file-hit {
    display: flex; align-items: center; gap: 6px; height: 100%;
    padding: 0 8px 0 26px; cursor: pointer; min-width: 0;
  }
  .file-row:not(.disabled) .file-hit:hover { background: var(--vscode-list-hoverBackground); }
  .file-row.disabled .file-hit { cursor: default; opacity: 0.55; }

  .tag {
    flex: none; width: 14px; text-align: center; font-weight: 700; font-size: 12px;
    font-family: var(--vscode-editor-font-family, monospace);
  }
  .tag-M { color: var(--vscode-gitDecoration-modifiedResourceForeground, #e2c08d); }
  .tag-A { color: var(--vscode-gitDecoration-addedResourceForeground, #81b88b); }
  .tag-D { color: var(--vscode-gitDecoration-deletedResourceForeground, #c74e39); }
  .tag-R { color: var(--vscode-gitDecoration-renamedResourceForeground, #73c991); }

  .path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .path .name { color: var(--vscode-foreground); }
  .path .dir { opacity: 0.55; font-size: 0.92em; margin-left: 6px; }

  .hunks { flex: none; opacity: 0.55; font-size: 11px; font-variant-numeric: tabular-nums; }
  .hunks.whole { font-style: italic; }

  /* --- themed compact checkbox --- */
  .chk {
    flex: none; width: 14px; height: 14px; margin: 0;
    accent-color: var(--vscode-button-background, #0e639c);
    cursor: pointer;
  }
  .chk:disabled { cursor: default; }

  /* --- banners --- */
  .banner {
    display: flex; align-items: center; gap: 6px;
    margin: 2px 8px 4px 26px; padding: 4px 8px; border-radius: 4px;
    font-size: 11.5px; line-height: 1.35;
  }
  .banner .codicon { font-size: 13px; flex: none; }
  .banner.error {
    background: var(--vscode-inputValidation-errorBackground, #5a1d1d);
    border: 1px solid var(--vscode-inputValidation-errorBorder, transparent);
  }
  .banner.warn {
    background: var(--vscode-inputValidation-warningBackground, #5a4a1d);
    border: 1px solid var(--vscode-inputValidation-warningBorder, transparent);
  }

  /* --- commit box (pinned bottom) --- */
  .commit-box {
    flex: none; border-top: 1px solid var(--vscode-panel-border);
    padding: 8px; display: flex; flex-direction: column; gap: 8px;
  }
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
  .btn.primary {
    flex: 1; justify-content: center;
    background: var(--vscode-button-background); color: var(--vscode-button-foreground);
  }
  .btn.primary:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
  .btn.secondary {
    background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground);
  }
  .btn.secondary:hover:not(:disabled) { background: var(--vscode-button-secondaryHoverBackground); }
  .btn:disabled { opacity: 0.4; cursor: default; }
  .btn:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }

  .spin { animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
