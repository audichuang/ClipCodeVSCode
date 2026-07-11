import * as vscode from 'vscode';
import { estimateTokens } from './copy.js';

// ponytail: fixed threshold; promote to a setting only if someone asks.
export const TOKEN_WARNING_THRESHOLD = 1_500_000;
const COPY_TOAST_MS = 2_000;

// Copy toast that auto-dismisses. A plain showInformationMessage stays in the
// notification area until manually closed; a progress notification closes
// itself when its promise resolves. Payloads over TOKEN_WARNING_THRESHOLD
// switch to a sticky warning so an oversized copy gets noticed.
export function notifyCopied(message: string, copiedText: string): void {
  const tokens = estimateTokens(copiedText);
  const note = `${message} ~${tokens.toLocaleString()} tokens.`;
  if (tokens > TOKEN_WARNING_THRESHOLD) {
    void vscode.window.showWarningMessage(
      `${note} Copied content exceeds ${TOKEN_WARNING_THRESHOLD.toLocaleString()} tokens.`
    );
    return;
  }
  void vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: note },
    () => new Promise<void>(resolve => setTimeout(resolve, COPY_TOAST_MS))
  );
}
