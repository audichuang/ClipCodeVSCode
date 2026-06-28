<script lang="ts">
  import { onMount, tick, untrack } from 'svelte';
  import { getVsCodeApi } from '../../lib/vscode-api';
  import { t } from '../../lib/i18n/index.svelte';
  import type { Commit } from '../../lib/types';
  import Modal from '../common/Modal.svelte';
  import { tooltip } from '../../lib/actions/tooltip';
  import { applyAutosquash, hasAutosquashTargets } from '../../lib/autosquash';

  interface Props {
    base: string;
    branchName?: string;
    baseSubject?: string;
    onClose: () => void;
  }

  let { base, branchName = 'HEAD', baseSubject = '', onClose }: Props = $props();

  const vscode = getVsCodeApi();

  interface TodoEntry {
    action: 'pick' | 'squash' | 'fixup' | 'reword' | 'edit' | 'drop';
    hash: string;
    subject: string;
    body: string;
    newMessage?: string;
  }

  let todos = $state<TodoEntry[]>([]);
  let initialOrder = $state<string[]>([]);
  let loading = $state(true);
  let dragIndex = $state<number | null>(null);
  let showActionMenu = $state<number | null>(null);
  let dropdownPos = $state<{ x: number; y: number }>({ x: 0, y: 0 });

  const ACTIONS: Array<{ value: TodoEntry['action']; icon: string; label: string; color: string }> = [
    { value: 'pick', icon: 'check', label: 'Pick', color: '#4caf50' },
    { value: 'reword', icon: 'edit', label: 'Reword', color: '#2196f3' },
    { value: 'edit', icon: 'debug-pause', label: 'Edit', color: '#9c27b0' },
    { value: 'squash', icon: 'fold', label: 'Squash', color: '#ff9800' },
    { value: 'fixup', icon: 'fold-down', label: 'Fixup', color: '#ff9800' },
    { value: 'drop', icon: 'trash', label: 'Drop', color: '#f44336' },
  ];

  const dropCount = $derived(todos.filter(t => t.action === 'drop').length);

  const orderChanged = $derived(
    todos.length === initialOrder.length &&
    todos.some((t, i) => t.hash !== initialOrder[i])
  );

  const hasChanges = $derived(todos.some(t => t.action !== 'pick') || orderChanged);

  // Original, freshly-loaded todo list (all `pick`, source order). Kept so the
  // autosquash toggle can restore it without re-fetching.
  let originalTodos = $state<TodoEntry[]>([]);
  let autosquashOn = $state(false);
  const canAutosquash = $derived(hasAutosquashTargets(originalTodos));

  // Rebuild the rendered list from the untouched `originalTodos` snapshot.
  function rebuildTodos(on: boolean) {
    autosquashOn = on;
    todos = on
      ? (applyAutosquash(originalTodos) as TodoEntry[])
      : originalTodos.map(t => ({ ...t }));
  }

  const squashGroups = $derived(todos.map((todo, i) => {
    const isSquashLike = (entry?: TodoEntry) => entry?.action === 'squash' || entry?.action === 'fixup';
    if (isSquashLike(todo)) return 'squash-member';
    if (isSquashLike(todos[i + 1])) return 'squash-target';
    return 'none';
  }));

  function autoresize(node: HTMLTextAreaElement) {
    function resize() {
      node.style.height = 'auto';
      node.style.height = node.scrollHeight + 'px';
    }
    // Defer initial resize until after value binding is applied
    tick().then(resize);
    node.addEventListener('input', resize);
    return {
      destroy() { node.removeEventListener('input', resize); },
      update() { tick().then(resize); },
    };
  }

  function fullMessage(todo: TodoEntry): string {
    return todo.body ? `${todo.subject}\n\n${todo.body}` : todo.subject;
  }

  function squashGroupMessage(startIndex: number): string {
    const parts: string[] = [];
    let i = startIndex;
    parts.push(fullMessage(todos[i]));
    i++;
    while (i < todos.length && (todos[i].action === 'squash' || todos[i].action === 'fixup')) {
      if (todos[i].action === 'squash') {
        parts.push(fullMessage(todos[i]));
      }
      i++;
    }
    return parts.join('\n\n');
  }

  /** Fingerprint of a squash group — changes when members or their actions change. */
  function squashFingerprint(startIndex: number): string {
    let i = startIndex;
    let fp = todos[i].hash;
    i++;
    while (i < todos.length && (todos[i].action === 'squash' || todos[i].action === 'fixup')) {
      fp += '|' + todos[i].hash + ':' + todos[i].action;
      i++;
    }
    return fp;
  }

  // Keyed by the squash-target's commit hash, not its list index: a drag
  // reorder moves a group to a different index, and an index-keyed map would
  // then compare against whatever group used to sit there and wrongly "reset"
  // the user's manually edited combined message. The hash is stable across
  // reordering, so the edit survives unless the group's composition changes.
  const groupPrints = $state<Record<string, string>>({});

  $effect.pre(() => {
    // Re-run when the list shape changes…
    void todos;
    void squashGroups;
    // …but don't track the writes below, or mutating todos[i].newMessage here
    // would re-trigger this same effect (read→write→read) and, when the whole
    // list is replaced on an autosquash toggle, spin into an update-depth loop
    // that wedges the component (only native controls keep working).
    untrack(() => {
      let i = 0;
      while (i < todos.length) {
        const todo = todos[i];
        const role = squashGroups[i];
        if (role === 'squash-target') {
          const fp = squashFingerprint(i);
          if (groupPrints[todo.hash] !== fp) {
            // Group composition changed — reset to new combined message
            groupPrints[todo.hash] = fp;
            todos[i].newMessage = squashGroupMessage(i);
          } else if (todo.newMessage === undefined) {
            // First time — initialize
            todos[i].newMessage = squashGroupMessage(i);
          }
          // Clear message on squash members
          i++;
          while (i < todos.length && (todos[i].action === 'squash' || todos[i].action === 'fixup')) {
            todos[i].newMessage = undefined;
            i++;
          }
          continue;
        }
        if (todo.action !== 'reword' && todo.newMessage !== undefined) {
          todos[i].newMessage = undefined;
        }
        i++;
      }
    });
  });

  onMount(() => {
    function handleMessage(event: MessageEvent) {
      const msg = event.data;
      if (msg.type === 'rebaseCommitsData') {
        const picks: TodoEntry[] = msg.payload.commits.map((c: Commit) => ({
          action: 'pick' as const,
          hash: c.hash,
          subject: c.subject,
          body: c.body,
        }));
        initialOrder = msg.payload.commits.map((c: Commit) => c.hash);
        // Snapshot for autosquash input / source-order restore (never rendered,
        // never mutated).
        originalTodos = picks;
        loading = false;
        // Autosquash is on by default when fixup!/squash! commits are present;
        // the modal is a preview, so nothing is applied until "Start Rebase".
        rebuildTodos(hasAutosquashTargets(picks));
      }
    }
    window.addEventListener('message', handleMessage);
    vscode.postMessage({ type: 'getRebaseCommits', payload: { base } });

    function handleClickOutside() {
      showActionMenu = null;
    }
    window.addEventListener('click', handleClickOutside);

    return () => {
      window.removeEventListener('message', handleMessage);
      window.removeEventListener('click', handleClickOutside);
    };
  });

  function setAction(index: number, action: TodoEntry['action']) {
    todos[index].action = action;
    if (action === 'reword') {
      todos[index].newMessage = fullMessage(todos[index]);
    } else {
      todos[index].newMessage = undefined;
    }
    showActionMenu = null;
  }

  function moveUp(index: number) {
    if (index <= 0) return;
    const item = todos.splice(index, 1)[0];
    todos.splice(index - 1, 0, item);
    todos = [...todos];
    guardFirstItem();
  }

  function moveDown(index: number) {
    if (index >= todos.length - 1) return;
    const item = todos.splice(index, 1)[0];
    todos.splice(index + 1, 0, item);
    todos = [...todos];
    guardFirstItem();
  }

  function handleDragStart(index: number) {
    dragIndex = index;
  }

  function handleDragOver(e: DragEvent, index: number) {
    e.preventDefault();
    if (dragIndex === null || dragIndex === index) return;
    const item = todos.splice(dragIndex, 1)[0];
    todos.splice(index, 0, item);
    todos = [...todos];
    dragIndex = index;
    guardFirstItem();
  }

  function handleDragEnd() {
    dragIndex = null;
  }

  function guardFirstItem() {
    const first = todos[0];
    if (first && (first.action === 'squash' || first.action === 'fixup')) {
      todos[0] = { ...first, action: 'pick', newMessage: undefined };
    }
  }

  function execute() {
    const allTodos = todos.map(t => ({
      action: t.action,
      hash: t.hash,
      subject: t.subject,
      message: t.newMessage,
    }));
    vscode.postMessage({
      type: 'interactiveRebase',
      payload: { base, todos: allTodos },
    });
    onClose();
  }

  function getActionInfo(action: TodoEntry['action']) {
    return ACTIONS.find(a => a.value === action) ?? ACTIONS[0];
  }
</script>

<Modal title={t('rebase.title')} {onClose}>
  {#if loading}
    <div class="rebase-loading"><span class="spinner"></span> {t('rebase.loading')}</div>
  {:else if todos.length === 0}
    <div class="rebase-empty">{t('rebase.noCommits')}</div>
  {:else}
    <div class="modal-context-card">
      <i class="codicon codicon-git-branch"></i>
      <span use:tooltip={branchName} class="modal-pill modal-pill--target"><span class="modal-pill-text">{branchName}</span></span>
      <i class="codicon codicon-arrow-right" style="color: var(--text-secondary);"></i>
      <i class="codicon codicon-git-commit"></i>
      <span use:tooltip={base} class="modal-pill modal-pill--source"><span class="modal-pill-text">{base.substring(0, 7)}</span></span>
    </div>
    <div class="rebase-header">
      <span class="rebase-count">{todos.length} commit{todos.length > 1 ? 's' : ''}</span>
      <span class="rebase-hint">{t('rebase.instructions')}</span>
    </div>

    {#if canAutosquash}
      <label class="autosquash-row">
        <span class="autosquash-switch">
          <input
            type="checkbox"
            role="switch"
            bind:checked={autosquashOn}
            oninput={(e) => rebuildTodos(e.currentTarget.checked)}
          />
          <span class="autosquash-slider"></span>
        </span>
        <span class="autosquash-text">
          <span class="autosquash-label">{t('rebase.autosquash')}</span>
          <span class="autosquash-desc">{t('rebase.autosquashHint')}</span>
        </span>
      </label>
    {/if}

    <div class="todo-list" class:drag-active={dragIndex !== null} role="list">
      {#each todos as todo, index (todo.hash)}
        {@const info = getActionInfo(todo.action)}
        {@const groupRole = squashGroups[index]}
        <div
          class="todo-item"
          class:dropped={todo.action === 'drop'}
          class:dragging={dragIndex === index}
          class:squash-target={groupRole === 'squash-target'}
          class:squash-member={groupRole === 'squash-member'}
          draggable="true"
          ondragstart={() => handleDragStart(index)}
          ondragover={(e) => handleDragOver(e, index)}
          ondragend={handleDragEnd}
          role="listitem"
        >
          <span class="drag-handle" use:tooltip={t('rebase.dragToReorder')}>
            <i class="codicon codicon-gripper"></i>
          </span>

          <div class="action-wrapper">
            <button
              class="action-badge"
              style="background: {info.color}"
              onclick={(e) => {
                e.stopPropagation();
                if (showActionMenu === index) { showActionMenu = null; return; }
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                dropdownPos = { x: rect.left, y: rect.bottom + 2 };
                showActionMenu = index;
              }}
              use:tooltip={t('rebase.clickToChangeAction')}
            >
              <i class="codicon codicon-{info.icon}"></i>
              {info.label}
              <i class="codicon codicon-chevron-down action-chevron"></i>
            </button>
          </div>

          <div class="todo-content">
            <span class="todo-hash">{todo.hash.substring(0, 7)}</span>
            {#if todo.action === 'reword' || groupRole === 'squash-target'}
              <textarea
                class="todo-message-input"
                rows="1"
                placeholder={todo.action === 'reword' ? t('rebase.inlineDesc.reword') : t('rebase.inlineDesc.squash')}
                use:tooltip={todo.subject}
                use:autoresize
                bind:value={todos[index].newMessage}
              ></textarea>
            {:else}
              <span class="todo-subject truncate" class:dropped-text={todo.action === 'drop'} use:tooltip={todo.subject}>{todo.subject}</span>
              {#if todo.action !== 'pick'}
                <span class="action-inline-desc">{t(`rebase.action.${todo.action}`)}</span>
              {/if}
            {/if}
          </div>

          <div class="move-btns">
            <button class="move-btn" disabled={index === 0} onclick={() => moveUp(index)} aria-label={t('rebase.moveUp')} use:tooltip={t('rebase.moveUp')}>
              <i class="codicon codicon-chevron-up"></i>
            </button>
            <button class="move-btn" disabled={index === todos.length - 1} onclick={() => moveDown(index)} aria-label={t('rebase.moveDown')} use:tooltip={t('rebase.moveDown')}>
              <i class="codicon codicon-chevron-down"></i>
            </button>
          </div>
        </div>
      {/each}

    </div>

    {#if showActionMenu !== null}
      {@const activeAction = todos[showActionMenu]?.action}
      {@const isFirst = showActionMenu === 0}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="action-dropdown" style="left: {dropdownPos.x}px; top: {dropdownPos.y}px;" onclick={(e) => e.stopPropagation()} onkeydown={() => {}}>
        {#each ACTIONS as act}
          {@const disabled = isFirst && (act.value === 'squash' || act.value === 'fixup')}
          <button
            class="action-option"
            class:active={activeAction === act.value}
            {disabled}
            use:tooltip={disabled ? t('rebase.cannotSquashFirst') : ''}
            onclick={() => !disabled && setAction(showActionMenu!, act.value)}
          >
            <i class="codicon codicon-{act.icon}" style="color: {disabled ? 'var(--text-secondary)' : act.color}"></i>
            <span>{act.label}</span>
            <span class="action-desc">{t(`rebase.action.${act.value}`)}</span>
          </button>
        {/each}
      </div>
    {/if}

    {#if dropCount > 0}
      <div class="rebase-warning">
        <i class="codicon codicon-warning"></i>
        <span>{t('rebase.dropWarning', { count: String(dropCount) })}</span>
      </div>
    {/if}

    <div class="form-actions">
      <button onclick={onClose}>{t('common.cancel')}</button>
      <button
        class="primary"
        disabled={!hasChanges}
        use:tooltip={hasChanges ? '' : t('rebase.noChanges')}
        onclick={execute}
      >{t('rebase.start')}</button>
    </div>
  {/if}
</Modal>

<style>
  .rebase-loading, .rebase-empty {
    padding: 24px;
    text-align: center;
    color: var(--text-secondary);
    font-size: inherit;
  }

  .rebase-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 10px;
  }

  .rebase-count {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-primary);
    background: var(--bg-secondary);
    padding: 2px 8px;
    border-radius: 10px;
  }

  .rebase-hint {
    font-size: 11px;
    color: var(--text-secondary);
  }

  .autosquash-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    margin-bottom: 10px;
    border: 1px solid var(--border-color);
    border-radius: 6px;
    background: var(--bg-secondary);
    cursor: pointer;
    user-select: none;
  }

  .autosquash-text {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
  }

  .autosquash-label {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-primary);
  }

  .autosquash-desc {
    font-size: 11px;
    color: var(--text-secondary);
  }

  /* Sliding on/off switch: hidden checkbox + a slider span (pseudo-elements
     don't render on <input>, so the thumb lives on the span). */
  .autosquash-switch {
    position: relative;
    display: inline-block;
    flex-shrink: 0;
    width: 30px;
    height: 16px;
  }

  .autosquash-switch input {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    opacity: 0;
    cursor: pointer;
    z-index: 1;
  }

  .autosquash-slider {
    position: absolute;
    inset: 0;
    border-radius: 8px;
    background: var(--border-color);
    transition: background 0.15s ease;
    pointer-events: none;
  }

  .autosquash-slider::after {
    content: '';
    position: absolute;
    top: 2px;
    left: 2px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: #fff;
    transition: transform 0.15s ease;
  }

  .autosquash-switch input:checked + .autosquash-slider {
    background: var(--vscode-button-background, #0e639c);
  }

  .autosquash-switch input:checked + .autosquash-slider::after {
    transform: translateX(14px);
  }

  .autosquash-switch input:focus-visible + .autosquash-slider {
    outline: 1px solid var(--vscode-focusBorder, #007fd4);
    outline-offset: 1px;
  }

  .todo-list {
    max-height: 350px;
    overflow-y: auto;
    border: 1px solid var(--border-color);
    border-radius: 6px;
  }

  .todo-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 5px 8px;
    border-bottom: 1px solid var(--border-color);
    font-size: inherit;
    transition: opacity 0.15s;
  }

  .todo-item:last-child {
    border-bottom: none;
  }

  .todo-item:hover {
    background: var(--bg-hover);
  }

  .todo-item.dropped {
    opacity: 0.5;
  }

  .todo-item.dragging {
    opacity: 0.7;
    background: rgba(0, 127, 212, 0.08);
    box-shadow: inset 0 0 0 2px var(--vscode-focusBorder, #007fd4);
    border-radius: 4px;
  }

  .drag-handle {
    cursor: grab;
    opacity: 0.45;
    font-size: inherit;
    user-select: none;
    flex-shrink: 0;
  }

  .drag-handle:hover {
    opacity: 0.8;
  }

  .todo-list.drag-active {
    cursor: grabbing;
  }

  .todo-list.drag-active .drag-handle {
    cursor: grabbing;
  }

  .action-wrapper {
    position: relative;
    flex-shrink: 0;
  }

  .action-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: 4px;
    font-size: 10px;
    font-weight: 600;
    color: #fff;
    border: none;
    cursor: pointer;
    min-width: 72px;
    text-transform: uppercase;
  }

  .action-badge:hover {
    filter: brightness(1.15);
  }

  .action-chevron {
    font-size: 10px;
    opacity: 0.7;
    margin-left: 2px;
  }

  .action-dropdown {
    position: fixed;
    z-index: 3000;
    background: var(--vscode-menu-background, var(--bg-secondary));
    border: 1px solid var(--vscode-menu-border, var(--border-color));
    border-radius: 6px;
    padding: 4px;
    min-width: 200px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    font-size: var(--vscode-font-size, 13px);
  }

  .action-option {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 5px 8px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--text-primary);
    font-size: 11px;
    cursor: pointer;
    text-align: left;
  }

  .action-option:hover {
    background: var(--bg-hover);
  }

  .action-option.active {
    background: var(--bg-selected);
  }

  .action-desc {
    color: var(--text-secondary);
    font-size: 10px;
    margin-left: auto;
  }

  .todo-hash {
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 11px;
    color: var(--text-secondary);
    flex-shrink: 0;
  }

  .todo-subject {
    flex: 1;
    min-width: 0;
  }

  .move-btns {
    display: flex;
    flex-direction: column;
    gap: 0;
    flex-shrink: 0;
    opacity: 0;
    transition: opacity 0.1s;
  }

  .todo-item:hover .move-btns {
    opacity: 1;
  }

  .move-btn {
    padding: 0 2px;
    background: transparent;
    border: none;
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 10px;
    line-height: 1;
    border-radius: 2px;
  }

  .move-btn:hover:not(:disabled) {
    color: var(--text-primary);
    background: var(--bg-hover);
  }

  .move-btn:disabled {
    opacity: 0.2;
    cursor: default;
  }

  .rebase-warning {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    background: rgba(244, 67, 54, 0.08);
    border: 1px solid rgba(244, 67, 54, 0.25);
    border-radius: 5px;
    color: #f44336;
    font-size: 11px;
    margin-top: 10px;
  }

  :global(body.vscode-light) .action-badge {
    color: #000;
  }

  :global(body.vscode-light) .rebase-warning {
    background: rgba(183, 28, 28, 0.06);
    border-color: rgba(183, 28, 28, 0.2);
    color: #b71c1c;
  }

  .form-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 12px;
  }

  .todo-content {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 1;
    min-width: 0;
  }

  .todo-message-input {
    flex: 1;
    min-width: 0;
    /* autoresize sets an inline height from scrollHeight; a tall min-height
       would override it and leave a single line top-aligned in the box.
       Keep min-height in step with the one-line content + vertical padding. */
    min-height: 24px;
    max-height: 160px;
    padding: 4px 6px;
    background: var(--vscode-input-background, var(--bg-secondary));
    border: 1px solid var(--vscode-input-border, var(--border-color));
    border-radius: 3px;
    color: var(--vscode-input-foreground, var(--text-primary));
    font-size: inherit;
    font-family: inherit;
    line-height: 1.3;
    resize: none;
    overflow-y: auto;
    outline: none;
  }

  .todo-message-input:focus {
    border-color: var(--vscode-focusBorder, #007fd4);
  }

  .action-inline-desc {
    font-size: 10px;
    color: var(--text-secondary);
    white-space: nowrap;
    flex-shrink: 0;
    opacity: 0.8;
  }

  .todo-item.squash-target {
    border-left: 3px solid #ff9800;
    background: rgba(255, 152, 0, 0.04);
  }

  .todo-item.squash-target:hover {
    background: rgba(255, 152, 0, 0.09);
  }

  .todo-item.squash-member {
    border-left: 3px solid #ff9800;
    padding-left: 14px;
    background: rgba(255, 152, 0, 0.04);
  }

  .todo-item.squash-member:hover {
    background: rgba(255, 152, 0, 0.09);
  }

  .dropped-text {
    text-decoration: line-through;
  }

  .action-option[disabled] {
    opacity: 0.35;
    cursor: not-allowed;
  }
</style>
