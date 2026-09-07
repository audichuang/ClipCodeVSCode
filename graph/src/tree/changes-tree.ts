import * as vscode from 'vscode';
import * as path from 'path';
import { buildChangeTree, type GroupNode, type RepoNode, type FileNode, type RepoStatus } from './build-change-tree';
/* SNIPCODE-HOOK start: Batch D latest-wins tree refresh */
import { SequenceGuard } from '../utils/sequence-guard';
/* SNIPCODE-HOOK end */
/* SNIPCODE-HOOK start: S5 own FileDecorationProvider */
import { changeUri, STATUS_LABEL } from './change-decorations';
/* SNIPCODE-HOOK end */

export type ChangeTreeNode = GroupNode | RepoNode | FileNode;

/* SNIPCODE-HOOK start: progressive first paint */
/** Trailing throttle for partial repaints while a multi-repo status read is in
 *  flight. Long enough that the fast repos of a pool land in one paint, short
 *  enough that a slow one does not delay showing the rest. */
const PARTIAL_PAINT_MS = 50;
/* SNIPCODE-HOOK end */

/** Loads per-repo staged/unstaged status for the tree. Injected by the host so
 *  the provider stays free of git plumbing. */
/* SNIPCODE-HOOK start: progressive first paint — `onPartial` receives the repos
   that have answered so far, in discovery order, as each one lands */
export type LoadStatus = (onPartial?: (partial: RepoStatus[]) => void) => Promise<RepoStatus[]>;
/* SNIPCODE-HOOK end */

/**
 * TreeDataProvider for the Snipcode Git commit workbench. Paints the IntelliJ
 * hierarchy Staged/Unstaged/Merge Conflicts → repo → file. File nodes carry a
 * `snipcode-change:` resourceUri (see change-decorations.ts) so VS Code still
 * resolves the native file-type icon by basename, while our own
 * FileDecorationProvider (registered in extension.ts) supplies the
 * badge/color/tooltip decoration — independent of vscode.git's, which can
 * only show one status per real `file:` path; `contextValue`
 * (`file-staged` / `file-unstaged` / `file-conflict`) drives the inline
 * stage/unstage/discard/mark-resolved menu.
 */
export class ChangesTreeProvider implements vscode.TreeDataProvider<ChangeTreeNode> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private groups: GroupNode[] = [];
  private commitScopeReady = false;
  /* SNIPCODE-HOOK start: Batch D latest-wins tree refresh */
  private readonly refreshSequence = new SequenceGuard();
  /* SNIPCODE-HOOK end */

  constructor(
    private readonly loadStatus: LoadStatus,
    /** Whether a staged repo is checked to be included in the next commit. */
    private readonly isCheckedForCommit: (repoPath: string) => boolean = () => true,
  ) {}

  /** Re-read status and repaint the tree. */
  async refresh(): Promise<void> {
    /* SNIPCODE-HOOK start: Batch D latest-wins tree refresh */
    const ticket = this.refreshSequence.issue();
    this.commitScopeReady = false;
    this._onDidChangeTreeData.fire();
    /* SNIPCODE-HOOK start: progressive first paint
       Paint the repos that have answered instead of a blank view until the last
       one does (25 repos, one on a slow disk: the other 24 used to wait for it).
       Trailing-throttled so a burst of completions costs one repaint, and gated
       on the ticket so a superseded refresh cannot repaint stale partials. The
       same empty→[] collapse as the final paint keeps "Staged 0 / Unstaged 0"
       rows from flashing before the first dirty repo arrives. */
    let partialTimer: ReturnType<typeof setTimeout> | undefined;
    let latestPartial: RepoStatus[] | undefined;
    const paintPartial = (partial: RepoStatus[]) => {
      latestPartial = partial;
      if (partialTimer) return;
      partialTimer = setTimeout(() => {
        partialTimer = undefined;
        if (!this.refreshSequence.isCurrent(ticket) || !latestPartial) return;
        const partialGroups = buildChangeTree(latestPartial);
        this.groups = partialGroups.every((g) => g.count === 0) ? [] : partialGroups;
        this._onDidChangeTreeData.fire();
      }, PARTIAL_PAINT_MS);
    };
    let repos: RepoStatus[];
    try { repos = await this.loadStatus(paintPartial); }
    finally { if (partialTimer) clearTimeout(partialTimer); }
    /* SNIPCODE-HOOK end */
    if (!this.refreshSequence.isCurrent(ticket)) return;
    const groups = buildChangeTree(repos);
    /* SNIPCODE-HOOK end */
    /* SNIPCODE-HOOK start: S12 empty/no-repo state drives viewsWelcome */
    // Lets package.json's viewsWelcome tell "no repo in this workspace" apart
    // from "repo(s), but nothing to commit" (both otherwise render as an empty
    // root — see the `groups.every` below).
    void vscode.commands.executeCommand('setContext', 'snipcode.changes.hasRepos', repos.length > 0);
    // `loaded` gates BOTH welcome texts (package.json viewsWelcome): until the
    // first load finishes, `hasRepos` is unset and the view showed "No git
    // repository found" for the whole multi-second load of a 25-repo workspace.
    void vscode.commands.executeCommand('setContext', 'snipcode.changes.loaded', true);
    // A totally clean workspace (or no repos at all) would otherwise paint a
    // permanent "Staged 0 / Unstaged 0" — collapse to an empty root instead so
    // the "No changes" / "No git repository" welcome content can show through.
    this.groups = groups.every((g) => g.count === 0) ? [] : groups;
    this.commitScopeReady = true;
    /* SNIPCODE-HOOK end */
    this._onDidChangeTreeData.fire();
  }

  /* SNIPCODE-HOOK start: Batch D exact-one-repo amend guard */
  isCommitScopeReady(): boolean { return this.commitScopeReady; }

  getStagedRepoCount(): number {
    return (this.groups.find(group => group.group === 'staged')?.repos ?? [])
      .filter(repo => this.isCheckedForCommit(repo.repoPath)).length;
  }

  getStagedFileCount(): number {
    return (this.groups.find(group => group.group === 'staged')?.repos ?? [])
      .filter(repo => this.isCheckedForCommit(repo.repoPath))
      .reduce((total, repo) => total + repo.files.length, 0);
  }

  notifyCommitSelectionChanged(): void {
    this._onDidChangeTreeData.fire();
  }
  /* SNIPCODE-HOOK end */

  /* SNIPCODE-HOOK start: S13 "already pushed" warning for Amend */
  /** True when Amend has exactly one target repo AND that repo's HEAD is not
   *  ahead of its upstream (`ahead === 0` — undefined means no upstream at
   *  all, which is not "pushed"). Amending it would rewrite already-pushed
   *  history. */
  getAmendTargetPushed(): boolean {
    const staged = (this.groups.find(group => group.group === 'staged')?.repos ?? [])
      .filter(repo => this.isCheckedForCommit(repo.repoPath));
    if (staged.length !== 1) return false;
    return staged[0].ahead === 0;
  }
  /* SNIPCODE-HOOK end */

  getChildren(node?: ChangeTreeNode): ChangeTreeNode[] {
    if (!node) return this.groups;
    if (node.kind === 'group') return node.repos;
    if (node.kind === 'repo') return node.files;
    return [];
  }

  getTreeItem(node: ChangeTreeNode): vscode.TreeItem {
    if (node.kind === 'group') {
      /* SNIPCODE-HOOK start: X1-4 group label through l10n (label is one of the
         fixed English strings in build-change-tree.ts's GROUP_LABEL, used as the
         l10n key so build-change-tree.ts itself can stay vscode-free) */
      const item = new vscode.TreeItem(vscode.l10n.t(node.label), vscode.TreeItemCollapsibleState.Expanded);
      /* SNIPCODE-HOOK end */
      item.description = `${node.count}`;
      item.contextValue = `group-${node.group}`;
      /* SNIPCODE-HOOK start: R3/S3 Merge Conflicts group icon/color; S12 error group */
      if (node.group === 'conflict') {
        item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('gitDecoration.conflictingResourceForeground'));
      } else if (node.group === 'error') {
        item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('errorForeground'));
      } else {
        item.iconPath = new vscode.ThemeIcon(node.group === 'staged' ? 'check' : 'diff-modified');
      }
      /* SNIPCODE-HOOK end */
      return item;
    }
    if (node.kind === 'repo') {
      /* SNIPCODE-HOOK start: S12 a repo whose status failed to read stays visible */
      if (node.group === 'error') {
        /* SNIPCODE-HOOK start: X1-4 error fallback text through l10n */
        const errText = node.error ?? vscode.l10n.t('unknown error');
        const errItem = new vscode.TreeItem(node.repoName, vscode.TreeItemCollapsibleState.None);
        errItem.description = errText;
        errItem.tooltip = `${node.repoPath}\n${errText}`;
        /* SNIPCODE-HOOK end */
        errItem.contextValue = 'repo-error';
        errItem.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('errorForeground'));
        errItem.id = `error:${node.repoPath}`;
        return errItem;
      }
      /* SNIPCODE-HOOK end */
      /* SNIPCODE-HOOK start: compact multi-repo summaries — keep the first
         paint useful on large workspaces; files are one explicit expansion
         away while the repo row remains a compact summary. Collapsing is
         conditional: a single-repo workspace has nothing to be crowded out
         by, so it stays expanded rather than costing every such user an
         extra click on every refresh. */
      const siblingRepoCount = this.groups.find(group => group.group === node.group)?.repos.length ?? 1;
      const item = new vscode.TreeItem(
        node.repoName,
        siblingRepoCount > 1
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.Expanded,
      );
      // IntelliJ-style incoming/outgoing badges; zero or no-upstream sides drop out.
      item.description = `${node.files.length} · ${node.branch}`
        + (node.behind ? ` ↓${node.behind}` : '')
        + (node.ahead ? ` ↑${node.ahead}` : '');
      /* SNIPCODE-HOOK end */
      item.contextValue = `repo-${node.group}`;
      item.iconPath = new vscode.ThemeIcon('repo');
      // Distinguish the same repo appearing under both groups.
      item.id = `${node.group}:${node.repoPath}`;
      // Staged repos get a checkbox: only checked repos are included in Commit.
      if (node.group === 'staged') {
        item.checkboxState = this.isCheckedForCommit(node.repoPath)
          ? vscode.TreeItemCheckboxState.Checked
          : vscode.TreeItemCheckboxState.Unchecked;
      }
      return item;
    }
    // file
    const absPath = path.join(node.repoPath, node.path);
    /* SNIPCODE-HOOK start: S5 own FileDecorationProvider — custom scheme carries
       status+group so our provider can badge/color this row without colliding
       with vscode.git's own (which only ever reflects one status per real
       `file:` path — wrong for an `MM` file shown on both Staged and Unstaged). */
    const uri = changeUri(absPath, node.status, node.group);
    /* SNIPCODE-HOOK end */
    const item = new vscode.TreeItem(uri, vscode.TreeItemCollapsibleState.None);
    const dir = path.dirname(node.path) === '.' ? '' : path.dirname(node.path);
    /* SNIPCODE-HOOK start: R4/S7 nested repo dirs get their own look; untracked files are labeled */
    if (node.status === 'N') {
      // An unregistered nested git repo (embedded gitlink risk if `git add`ed) —
      // show it like a repo, not a plain file, so Stage All doesn't look safe.
      item.iconPath = new vscode.ThemeIcon('repo');
      item.description = '(nested repo)';
    } else if (node.status === 'U') {
      item.description = dir ? `${dir} · untracked` : 'untracked';
    } else {
      /* SNIPCODE-HOOK start: S P2 rename description shows the old path */
      item.description = node.oldPath ? `${dir}${dir ? ' ' : ''}← ${node.oldPath}` : dir;
      /* SNIPCODE-HOOK end */
    }
    /* SNIPCODE-HOOK end */
    item.contextValue = `file-${node.group}`;
    item.resourceUri = uri; // file-icon-theme icon (by basename) + our decoration
    item.id = `${node.group}:${node.repoPath}:${node.path}`;
    /* SNIPCODE-HOOK start: S5 tooltip: path + human status + which side */
    const sideSuffix = node.group === 'staged' ? ' (staged)' : node.group === 'conflict' ? ' (unresolved)' : '';
    item.tooltip = `${node.path}\n${STATUS_LABEL[node.status] ?? node.status}${sideSuffix}`;
    /* SNIPCODE-HOOK end */
    item.command = {
      command: 'snipcode.git.showDiff',
      title: 'Show Diff',
      arguments: [node],
    };
    return item;
  }
}
