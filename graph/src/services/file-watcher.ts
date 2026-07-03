import * as vscode from 'vscode';
import * as path from 'path';
import { resolveGitDirs, classifyPath } from './file-watcher-helpers';

export class FileWatcher implements vscode.Disposable {
  private watchers: vscode.FileSystemWatcher[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private cooldownTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly DEBOUNCE_MS = 500;
  private refreshing = false;
  private disposed = false;
  public enabled = true;
  private gitDir: string;
  private commonDir: string;

  constructor(
    private repoPath: string,
    private onChange: (what: string) => void
  ) {
    const resolved = resolveGitDirs(repoPath);
    this.gitDir = resolved.gitDir;
    this.commonDir = resolved.commonDir;

    // Per-worktree paths (gitDir):
    //   HEAD, index, MERGE_HEAD, REBASE_HEAD live in the per-worktree gitdir
    //   for linked worktrees, and in `.git` for regular repos (gitDir==commonDir).
    this.addWatcher(new vscode.RelativePattern(this.gitDir, 'HEAD'));
    this.addWatcher(new vscode.RelativePattern(this.gitDir, 'index'));
    this.addWatcher(new vscode.RelativePattern(this.gitDir, 'MERGE_HEAD'));
    this.addWatcher(new vscode.RelativePattern(this.gitDir, 'REBASE_HEAD'));

    // Shared paths (commonDir):
    //   refs/, packed-refs, config, worktrees/ are shared across all worktrees
    //   so we watch them at the main gitdir.
    this.addWatcher(new vscode.RelativePattern(this.commonDir, 'refs/**'));
    this.addWatcher(new vscode.RelativePattern(this.commonDir, 'refs/stash'));
    this.addWatcher(new vscode.RelativePattern(this.commonDir, 'packed-refs'));
    this.addWatcher(new vscode.RelativePattern(this.commonDir, 'config'));
    this.addWatcher(new vscode.RelativePattern(this.commonDir, 'worktrees/**'));

    // Watch working tree for file changes (exclude heavy dirs via specific patterns)
    // Using {src,lib,app,...}/** would be too restrictive, so we watch ** but filter
    this.addWatcher(new vscode.RelativePattern(repoPath, '**'), true);
  }

  // Directories to ignore for working tree changes (Set for O(1) lookup)
  private static readonly IGNORE_DIRS = new Set([
    'node_modules', '.git', 'dist', 'build', 'out', '.next',
    '.nuxt', '__pycache__', '.venv', 'vendor', 'target',
    '.gradle', '.idea', '.vs', 'coverage', '.nyc_output',
  ]);

  private addWatcher(pattern: vscode.RelativePattern, workingTree = false): void {
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    const handler = (uri: vscode.Uri) => {
      if (workingTree) {
        // Skip .git and common heavy directories
        const normalizedPath = uri.fsPath.split(path.sep);
        if (normalizedPath.some(seg => FileWatcher.IGNORE_DIRS.has(seg))) {
          return;
        }
      }
      this.scheduleRefresh(workingTree ? 'status' : this.classifyChange(uri));
    };

    watcher.onDidChange(handler);
    watcher.onDidCreate(handler);
    watcher.onDidDelete(handler);
    this.watchers.push(watcher);
  }

  private classifyChange(uri: vscode.Uri): string {
    return classifyPath(uri.fsPath, this.gitDir, this.commonDir);
  }

  private pendingChanges = new Set<string>();
  private pendingWhileRefreshing = false;

  private scheduleRefresh(what: string): void {
    // Guard against post-dispose calls or disabled state
    if (this.disposed || !this.enabled) {
      return;
    }

    // If currently in the refresh cooldown, flag for re-trigger instead of dropping
    if (this.refreshing) {
      this.pendingWhileRefreshing = true;
      this.pendingChanges.add(what);
      return;
    }

    this.pendingChanges.add(what);

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this.debounceTimer = setTimeout(() => {
      this.refreshing = true;
      // Pick the most significant change type
      const changeType = this.pendingChanges.has('refs') ? 'refs'
        : this.pendingChanges.has('operation') ? 'operation'
        : this.pendingChanges.has('status') ? 'status'
        : 'unknown';
      this.pendingChanges.clear();

      try {
        this.onChange(changeType);
      } finally {
        // Prevent re-triggering for 1 second after refresh
        this.cooldownTimer = setTimeout(() => {
          this.cooldownTimer = null;
          this.refreshing = false;
          if (this.disposed) return;
          // Re-trigger if changes came in during refresh cooldown
          if (this.pendingWhileRefreshing) {
            this.pendingWhileRefreshing = false;
            if (this.pendingChanges.size > 0) {
              this.scheduleRefresh('unknown');
            }
          }
        }, 1000);
      }
    }, this.DEBOUNCE_MS);
  }

  /** Absorb watcher events for `durationMs` ms. Call this immediately after the
   *  extension performs its own git operation + explicit refresh, so the
   *  filesystem changes caused by that operation don't trigger a redundant
   *  second refresh.
   *
   *  The op's `.git` writes happen DURING the awaited git call — i.e. before the
   *  handler's refreshAll() reaches here — so by now a debounce may already be
   *  armed. We cancel it and drop every queued event: the handler always runs an
   *  explicit refreshAll() that re-reads git state AFTER the op, so re-firing the
   *  op's own events would only schedule a redundant second full refresh (the
   *  "keeps loading after it looked done" tail). A genuine external change landing
   *  inside the window is dropped too, but that's a narrow race right after the
   *  user's own click and self-heals on the next filesystem event / auto-fetch. */
  public suppress(durationMs = 1000): void {
    if (this.disposed) { return; }
    this.refreshing = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.pendingChanges.clear();
    this.pendingWhileRefreshing = false;
    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer);
    }
    this.cooldownTimer = setTimeout(() => {
      this.cooldownTimer = null;
      this.refreshing = false;
      if (this.disposed) { return; }
      // Events during the window were the op's own FS churn — drop them rather
      // than re-triggering. (External-change handling during a *normal* refresh
      // still works via the debounce path's own cooldown re-trigger.)
      this.pendingWhileRefreshing = false;
      this.pendingChanges.clear();
    }, durationMs);
  }

  dispose(): void {
    this.disposed = true;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    if (this.cooldownTimer) {
      clearTimeout(this.cooldownTimer);
    }
    this.watchers.forEach(w => w.dispose());
  }
}
