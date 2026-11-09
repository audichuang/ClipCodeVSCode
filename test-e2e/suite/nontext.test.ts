import * as assert from 'node:assert';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import * as vscode from 'vscode';

const repoDir = process.env.SNIPCODE_E2E_REPO as string;

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

// Answer every modal by button: Include for the non-text dialog, Proceed for the restore
// confirmation. The recorded button lists prove which dialogs actually appeared.
function stubWarnings(): { calls: unknown[][]; restore: () => void } {
  const original = vscode.window.showWarningMessage;
  const calls: unknown[][] = [];
  (vscode.window as any).showWarningMessage = async (...args: unknown[]) => {
    calls.push(args);
    const buttons = args.slice(2) as string[];
    if (buttons.includes('Include')) return 'Include';
    if (buttons.includes('Proceed')) return 'Proceed';
    return undefined;
  };
  return { calls, restore: () => { (vscode.window as any).showWarningMessage = original; } };
}

describe('Snipcode non-text files (real workspace)', () => {
  const dir = 'e2e-nontext';

  before(async () => {
    const ext = vscode.extensions.getExtension('audichuang.clipcode-vscode');
    assert.ok(ext, 'extension present');
    await ext!.activate();
  });

  it('copies PNG + docx + Big5 csv with Include and restores every file byte-identical', async () => {
    assert.ok(repoDir, 'SNIPCODE_E2E_REPO env set');
    const root = path.join(repoDir, dir, 'src');
    await fs.rm(path.join(repoDir, dir), { recursive: true, force: true });
    await fs.mkdir(root, { recursive: true });

    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]),
      Buffer.alloc(300, 0),
      Buffer.from('IHDR\x00\x00\x00\x10\x00\x00\x00\x10', 'latin1'),
    ]);
    // A zip container: PK header, NUL padding and high bytes that are not valid UTF-8.
    const docx = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00, 0x08, 0x00]),
      Buffer.from(Array.from({ length: 700 }, (_, i) => (i * 37 + 11) & 0xff)),
      Buffer.from('word/document.xml', 'latin1'),
    ]);
    // Big5 for "姓名,城市" / "王小明,台北": no NUL, but invalid UTF-8.
    const csv = Buffer.from([
      0xb9, 0x4c, 0xa6, 0x57, 0x2c, 0xb0, 0xea, 0xa5, 0xab, 0x0a,
      0xa4, 0xb9, 0xa4, 0x70, 0xa9, 0xfa, 0x2c, 0xa5, 0x78, 0xa5, 0x5f,
    ]);
    const originals = new Map<string, Buffer>([
      ['logo.png', png],
      ['report.docx', docx],
      ['people.csv', csv],
    ]);
    for (const [name, bytes] of originals) await fs.writeFile(path.join(root, name), bytes);

    const warnings = stubWarnings();
    try {
      const uri = vscode.Uri.file(root);
      await vscode.commands.executeCommand('clipcode.copyToClipboard', uri, [uri]);
      const included = warnings.calls.filter(call => (call.slice(2) as string[]).includes('Include'));
      assert.equal(included.length, 1, 'the non-text dialog appeared once');
      assert.deepStrictEqual(included[0].slice(2), ['Include', 'Exclude']);

      const clip = await vscode.env.clipboard.readText();
      assert.ok(clip.includes(`// File skipped: non-text file, ${png.length} bytes, sha256 ${sha256(png)}; base64 follows`), 'PNG carried as Base64');

      // Restore into an empty folder: everything under the source folder is gone first.
      await fs.rm(path.join(repoDir, dir), { recursive: true, force: true });
      await vscode.commands.executeCommand('clipcode.pasteAndRestoreFiles');
    } finally {
      warnings.restore();
    }

    for (const [name, want] of originals) {
      const got = await fs.readFile(path.join(root, name));
      assert.equal(sha256(got), sha256(want), `${name} must restore byte-identical`);
    }
    assert.deepStrictEqual((await fs.readdir(root)).sort(), [...originals.keys()].sort());
  });

  it('pastes the shared fixture PNG payload byte-identical to its declared digest', async () => {
    const ext = vscode.extensions.getExtension('audichuang.clipcode-vscode')!;
    const fixture = JSON.parse(await fs.readFile(path.join(ext.extensionPath, 'test/fixtures/clipboard-contract.json'), 'utf8'));
    const row = fixture.nonTextRestoreCases.find((c: { name: string }) => c.name.startsWith('round trip: PNG with NUL bytes'));
    assert.ok(row, 'fixture row present');
    assert.equal(row.headerFormat, '// file: $FILE_PATH');
    const create = row.creates[0] as { path: string; base64: string };
    const want = Buffer.from(create.base64, 'base64');
    const target = path.join(repoDir, create.path);
    await fs.rm(target, { force: true });

    await vscode.env.clipboard.writeText(row.payload);
    const warnings = stubWarnings();
    try {
      await vscode.commands.executeCommand('clipcode.pasteAndRestoreFiles');
    } finally {
      warnings.restore();
    }

    assert.equal(sha256(await fs.readFile(target)), sha256(want));
    assert.ok(want.includes(0), 'fixture PNG contains NUL bytes');
    await fs.rm(path.join(repoDir, create.path.split('/')[0]), { recursive: true, force: true });
  });
});
