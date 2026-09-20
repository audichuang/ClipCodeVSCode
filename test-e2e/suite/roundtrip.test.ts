import * as assert from 'node:assert';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import * as vscode from 'vscode';

const repoDir = process.env.SNIPCODE_E2E_REPO as string;

// Stub warning dialogs so restore choices are deterministic, while recording the actual
// button lists to prove each test followed the intended confirmation path.
function stubWarnings(answers: string[]): { calls: unknown[][]; restore: () => void } {
  const original = vscode.window.showWarningMessage;
  const calls: unknown[][] = [];
  let i = 0;
  (vscode.window as any).showWarningMessage = async (...args: unknown[]) => {
    calls.push(args);
    return answers[i++];
  };
  return { calls, restore: () => { (vscode.window as any).showWarningMessage = original; } };
}

async function runRestore(answers: string[]): Promise<unknown[][]> {
  const warnings = stubWarnings(answers);
  try {
    await vscode.commands.executeCommand('clipcode.pasteAndRestoreFiles');
    return warnings.calls;
  } finally {
    warnings.restore();
  }
}

async function restorePayload(payload: string, answers: string[]): Promise<unknown[][]> {
  await vscode.env.clipboard.writeText(payload);
  return runRestore(answers);
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
    'bom.ts': '\uFEFFexport const bom = true;',
    'empty.ts': '',
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
    const config = vscode.workspace.getConfiguration('clipcode');
    const previousPostText = config.get<string>('postText', '');
    await config.update('postText', '</files>', vscode.ConfigurationTarget.Workspace);

    try {
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
      assert.ok(clip.includes('// clipcode-end'), 'footer has an explicit terminator');
      assert.ok(clip.endsWith('</files>'), 'configured footer remains outside file content');
      assert.ok(clip.includes('\uFEFFexport const bom'), 'leading UTF-8 BOM survives copy decoding');
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
      await runRestore(['Proceed', 'Overwrite All']);

      // 5. Assert every restored file is byte-identical to its original, including empty and BOM files.
      for (const [rel, want] of originals) {
        const got = await fs.readFile(abs(rel));
        assert.deepStrictEqual(got, want, `restored ${rel} must be byte-identical to original`);
      }
    } finally {
      await config.update('postText', previousPostText, vscode.ConfigurationTarget.Workspace);
    }
  });

  it('Skip Existing leaves the target bytes unchanged', async () => {
    const relative = `${dir}/skip-existing.ts`;
    const target = path.join(repoDir, relative);
    const original = Buffer.from('keep these exact bytes');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, original);

    const calls = await restorePayload(`// file: ${relative}\nreplacement`, ['Proceed', 'Skip Existing']);

    assert.equal(calls.length, 2, 'proceed and existing-file choices were both shown');
    assert.deepStrictEqual(calls[0].slice(2), ['Proceed']);
    assert.deepStrictEqual(calls[1].slice(2), ['Overwrite All', 'Skip Existing', 'Cancel']);
    assert.deepStrictEqual(await fs.readFile(target), original, 'Skip Existing preserves exact bytes');
  });

  it('Overwrite All replaces the existing target bytes', async () => {
    const relative = `${dir}/overwrite-all.ts`;
    const target = path.join(repoDir, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, 'before');

    const calls = await restorePayload(`// file: ${relative}\nafter`, ['Proceed', 'Overwrite All']);

    assert.equal(calls.length, 2, 'proceed and existing-file choices were both shown');
    assert.deepStrictEqual(calls[0].slice(2), ['Proceed']);
    assert.deepStrictEqual(calls[1].slice(2), ['Overwrite All', 'Skip Existing', 'Cancel']);
    assert.deepStrictEqual(await fs.readFile(target), Buffer.from('after'));
  });

  it('Overwrite All updates UTF-8 files but preserves a UTF-16 BOM target', async () => {
    const safeRelative = `${dir}/overwrite-safe.ts`;
    const protectedRelative = `${dir}/utf16-target.ts`;
    const safeTarget = path.join(repoDir, safeRelative);
    const protectedTarget = path.join(repoDir, protectedRelative);
    const utf16Bytes = Buffer.from([0xff, 0xfe, 0x41, 0x00, 0x42, 0x00]);
    await fs.mkdir(path.dirname(safeTarget), { recursive: true });
    await fs.writeFile(safeTarget, 'safe-before');
    await fs.writeFile(protectedTarget, utf16Bytes);

    const payload = `// file: ${safeRelative}\nsafe-after\n\n// file: ${protectedRelative}\nreplacement`;
    const calls = await restorePayload(payload, ['Proceed', 'Overwrite All']);

    assert.equal(calls.length, 2, 'Overwrite All was selected while the unsafe target was present');
    assert.deepStrictEqual(calls[1].slice(2), ['Overwrite All', 'Skip Existing', 'Cancel']);
    assert.deepStrictEqual(await fs.readFile(safeTarget), Buffer.from('safe-after'));
    assert.deepStrictEqual(await fs.readFile(protectedTarget), utf16Bytes, 'UTF-16 BOM and bytes survive');
  });

  it('[DELETED] removes an existing file under the fixture directory', async () => {
    const relative = `${dir}/delete-me.ts`;
    const target = path.join(repoDir, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, 'remove this file');

    const calls = await restorePayload(`// file: [DELETED] ${relative}\nold content`, ['Proceed']);

    assert.equal(calls.length, 1, 'deletion requires the Proceed confirmation only');
    assert.deepStrictEqual(calls[0].slice(2), ['Proceed']);
    await assert.rejects(fs.stat(target), { code: 'ENOENT' });
  });
});
