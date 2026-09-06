/* SNIPCODE-HOOK: whole file — S5. Snipcode's own FileDecorationProvider for the
 * Changes tree. vscode.git's built-in decoration only ever reflects ONE status
 * per real `file:` path, so a file that is both staged and unstaged (`MM`)
 * shows the same colour/badge on both tree rows, and repos vscode.git doesn't
 * manage (deep/nested repos found by RepoDiscoveryService) get no decoration
 * at all. Giving each file node its own `snipcode-change:` URI (status + group
 * carried as query params) lets us decorate every row correctly regardless of
 * what vscode.git thinks — and, because the scheme differs from `file:`,
 * vscode.git's own provider simply never matches these URIs, so there is no
 * double-decoration to fight with. */
import * as vscode from 'vscode';

/** Custom scheme for Changes-tree file resourceUris. Keeps the file's basename
 *  (so file-icon themes still resolve the right icon) but carries `status` +
 *  `group` as query params for provideFileDecoration to read back. */
export const CHANGE_URI_SCHEME = 'snipcode-change';

/** Build a decorable resourceUri for one Changes-tree file node. */
export function changeUri(absPath: string, status: string, group: string): vscode.Uri {
  return vscode.Uri.file(absPath).with({
    scheme: CHANGE_URI_SCHEME,
    query: new URLSearchParams({ status, group }).toString(),
  });
}

/** Human label per porcelain status letter — shared by the decoration tooltip
 *  and the TreeItem tooltip so the two never drift. */
export const STATUS_LABEL: Record<string, string> = {
  M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', U: 'Untracked', N: 'Nested repo', '!': 'Conflicting',
};

/** `gitDecoration.*` theme color id per status letter. The staged side uses
 *  the dedicated `stageModified`/`stageDeleted` tokens where VS Code defines
 *  one; added/renamed/conflicting have no staged-specific token upstream, so
 *  both sides share the same color for those. */
function colorId(status: string, group: string): string {
  const staged = group === 'staged';
  switch (status) {
    case 'M': return staged ? 'gitDecoration.stageModifiedResourceForeground' : 'gitDecoration.modifiedResourceForeground';
    case 'D': return staged ? 'gitDecoration.stageDeletedResourceForeground' : 'gitDecoration.deletedResourceForeground';
    case 'A': return 'gitDecoration.addedResourceForeground';
    case 'R': return 'gitDecoration.renamedResourceForeground';
    case 'C': return 'gitDecoration.renamedResourceForeground';
    case 'U': return 'gitDecoration.untrackedResourceForeground';
    case '!': return 'gitDecoration.conflictingResourceForeground';
    default: return 'gitDecoration.modifiedResourceForeground';
  }
}

export class ChangeDecorationProvider implements vscode.FileDecorationProvider {
  private readonly _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== CHANGE_URI_SCHEME) return undefined;
    const params = new URLSearchParams(uri.query);
    const status = params.get('status') ?? '';
    const group = params.get('group') ?? 'unstaged';
    // A nested repo directory (N) gets a plain repo icon (changes-tree.ts) and
    // no badge/color — a status letter on it would suggest it's stageable.
    if (!status || status === 'N') return undefined;
    return {
      badge: status,
      color: new vscode.ThemeColor(colorId(status, group)),
      tooltip: STATUS_LABEL[status] ?? status,
    };
  }

  dispose(): void {
    this._onDidChangeFileDecorations.dispose();
  }
}
