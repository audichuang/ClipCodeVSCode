import * as vscode from 'vscode';
import { estimateTokens } from './copy.js';

// ponytail: fixed thresholds; promote to settings only if someone asks.
// VS Code has no notification colour API — info / warning / error ARE the
// colours (default, yellow, red), so severity is the only knob available.
export const TOKEN_WARN_THRESHOLD = 1_000_000;
export const TOKEN_DANGER_THRESHOLD = 2_000_000;
const COPY_TOAST_MS = 2_000;

// Grouping pinned to en-US, not the host locale: the IntelliJ mirror renders the same
// count via Locale.ROOT and the two must not disagree on `1,234` vs `1.234`.
const grouped = (n: number) => n.toLocaleString('en-US');

export interface CopyToastAction {
  label: string;
  run: () => void;
}

/**
 * Copy toast. Under TOKEN_WARN_THRESHOLD it auto-dismisses (a plain
 * showInformationMessage would sit in the notification area until closed by hand;
 * a progress notification closes itself when its promise resolves). Above the
 * thresholds it becomes a sticky yellow warning, then a red error, so an oversized
 * copy gets noticed before it is pasted somewhere that will reject it.
 *
 * Never awaits the toast: an action-button notification never auto-dismisses, so
 * awaiting would block the copy from returning (hangs headless e2e).
 */
export function notifyCopied(message: string, copiedText: string, action?: CopyToastAction): void {
  const tokens = estimateTokens(copiedText);
  const note = `${message} ~${grouped(tokens)} tokens.`;
  const buttons = action ? [action.label] : [];
  const onPick = (picked?: string) => {
    if (action && picked === action.label) action.run();
  };

  if (tokens >= TOKEN_DANGER_THRESHOLD) {
    void vscode.window
      .showErrorMessage(`${note} Over ${grouped(TOKEN_DANGER_THRESHOLD)} tokens.`, ...buttons)
      .then(onPick);
    return;
  }
  if (tokens >= TOKEN_WARN_THRESHOLD) {
    void vscode.window
      .showWarningMessage(`${note} Over ${grouped(TOKEN_WARN_THRESHOLD)} tokens.`, ...buttons)
      .then(onPick);
    return;
  }
  if (action) {
    void vscode.window.showInformationMessage(note, ...buttons).then(onPick);
    return;
  }
  void vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: note },
    () => new Promise<void>(resolve => setTimeout(resolve, COPY_TOAST_MS))
  );
}
