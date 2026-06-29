import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import * as vscode from 'vscode';

const repoDir = process.env.SNIPCODE_E2E_REPO as string;

// Stub vscode.window.showWarningMessage so the two restore modals resolve to
// fixed choices instead of blocking on a real dialog. Returns a restore fn.
// `answers` are consumed in call order: first = "Proceed", second = "Overwrite All".
function stubWarnings(answers: string[]): () => void {
  const original = vscode.window.showWarningMessage;
  let i = 0;
  (vscode.window as any).showWarningMessage = async (..._args: unknown[]) => answers[i++];
  return () => {
    (vscode.window as any).showWarningMessage = original;
  };
}

describe('Snipcode copy → restore round-trip (real workspace)', () => {
  // A dedicated subdir so we don't collide with the files the integration spec asserts on.
  const dir = 'e2e-roundtrip';
  // One file deliberately contains a "// file: ..."-style line to exercise the
  // header-escaping fix (#3): if escaping is wrong, restore mangles or splits it.
  //
  // NOTE: the clipboard format strips leading/trailing blank lines as structural
  // (see joinContent in src/clipboardFormat.ts — a content trailing '\n' is
  // indistinguishable on the wire from the inter-file separator). So fixtures
  // deliberately have no leading/trailing blank line; byte-identical round-trip
  // only holds for the format's actual guarantee, which is what we assert.
  const files: Record<string, string> = {
    'plain.ts': 'export const x = 1;\nconst y = x + 1;',
    'tricky.ts': [
      'export const a = 1;',
      '// file: not-a-real-header.ts', // looks exactly like a Snipcode header
      '# file: also/tricky.py',
      'const done = true;',
    ].join('\n'),
    'sub/nested.ts': 'export const nested = "ok";',
  };

  before(async () => {
    const ext = vscode.extensions.getExtension('audichuang.clipcode-vscode');
    assert.ok(ext, 'extension present');
    await ext!.activate();
  });

  it('copies real files, clears them, restores them byte-identical', async () => {
    assert.ok(repoDir, 'SNIPCODE_E2E_REPO env set');

    // 1. Write the originals to disk and remember their exact bytes.
    const abs = (rel: string) => path.join(repoDir, dir, rel);
    const originals = new Map<string, Buffer>();
    for (const [rel, content] of Object.entries(files)) {
      const p = abs(rel);
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, content, 'utf8');
      originals.set(rel, await fs.readFile(p));
    }

    // 2. Copy them via the real command (uri, uris) — pass them as the multi-select arg.
    const uris = Object.keys(files).map((rel) => vscode.Uri.file(abs(rel)));
    await vscode.commands.executeCommand('clipcode.copyToClipboard', uris[0], uris);

    const clip = await vscode.env.clipboard.readText();
    assert.ok(clip.trim().length > 0, 'clipboard populated by copy');
    // Sanity: the tricky header-like lines must NOT survive verbatim in the payload —
    // they have to be escaped, otherwise restore would treat them as new file headers.
    assert.ok(
      !/\n\/\/ file: not-a-real-header\.ts\n/.test(clip),
      'header-like content line is escaped in the payload, not left bare',
    );

    // 3. Delete the originals so restore has to recreate them from the clipboard.
    for (const rel of Object.keys(files)) {
      await fs.rm(abs(rel), { force: true });
    }

    // 4. Restore. First modal → "Proceed", second (existing files) → "Overwrite All".
    // Files are deleted so the second modal may not appear; extra answers are harmless.
    const restore = stubWarnings(['Proceed', 'Overwrite All']);
    try {
      await vscode.commands.executeCommand('clipcode.pasteAndRestoreFiles');
    } finally {
      restore();
    }

    // 5. Assert every restored file is byte-identical to its original.
    for (const [rel, want] of originals) {
      const got = await fs.readFile(abs(rel));
      assert.deepStrictEqual(got, want, `restored ${rel} must be byte-identical to original`);
    }
  });
});
