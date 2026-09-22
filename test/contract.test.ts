import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildGitPayload,
  buildPayload,
  parseClipboard,
  type ChangeTypeLabel,
  type PayloadFile
} from '../src/clipboardFormat.js';
import { estimateTokens, payloadStats } from '../src/copy.js';
import { resolveDeleteTarget, resolveWriteTarget, type RestoreTargetResolution } from '../src/pathResolver.js';

// Shared cross-tool contract goldens — the SAME file is committed byte-identically
// in the IntelliJ repo (ClipCode/src/test/resources/clipboard-contract.json). Both
// sides assert their build + parse match these frozen bytes, so neither can drift
// from the contract without a red test. Regenerate via scripts/gen-contract-fixtures.cjs
// and update EXPECTED_FIXTURES_SHA on BOTH sides.
const EXPECTED_FIXTURES_SHA = '2d5908a5a247fcc564380a4c5ec1b8f188bcc50fae9d039aa0f8e200c37a9771';
const FIXTURES_PATH = path.join(process.cwd(), 'test', 'fixtures', 'clipboard-contract.json');

interface BuildOptions {
  headerFormat: string;
  preText: string;
  postText: string;
  addExtraLineBetweenFiles: boolean;
  files: PayloadFile[];
  sourceRoot?: string;
}
interface BuildCase { name: string; kind: 'regular' | 'git'; options: BuildOptions; wire: string; }
interface ExpectedEntry { path: string; content: string; changeTypes: string[]; }
interface ParseCase { name: string; headerFormat: string; input: string; expected: ExpectedEntry[]; }
interface TokenCase { name: string; text: string; chars: number; lines: number; words: number; tokens: number; }
type PathOutcome = { root: string; path: string } | 'refused' | 'missing' | 'ambiguous';
interface PathCase { input: string; needsSymlink?: boolean; write: PathOutcome; delete: PathOutcome; }
interface PathLayout { roots: string[]; dirs: string[]; files: Record<string, string>; symlinks: Record<string, string>; }
interface Fixtures {
  buildCases: BuildCase[];
  parseCases: ParseCase[];
  tokenCases: TokenCase[];
  pathLayout: PathLayout;
  pathCases: PathCase[];
}

const rawFixtures = readFileSync(FIXTURES_PATH);
const fixtures: Fixtures = JSON.parse(rawFixtures.toString('utf8'));

test('contract fixtures file is byte-identical to the frozen SHA (kept in sync with the IntelliJ copy)', () => {
  const sha = createHash('sha256').update(rawFixtures).digest('hex');
  assert.equal(
    sha,
    EXPECTED_FIXTURES_SHA,
    'Fixtures changed. Regenerate, copy to ClipCode/src/test/resources/, and update EXPECTED_FIXTURES_SHA on BOTH sides.'
  );
});

for (const c of fixtures.buildCases) {
  test(`build ${c.kind}: ${c.name}`, () => {
    const built = c.kind === 'git' ? buildGitPayload(c.options) : buildPayload(c.options);
    assert.equal(built, c.wire);
  });
}

// Every number in the copy notification must be the SAME in both tools for the same
// clipboard text — the IntelliJ mirror (TokenEstimator.stats) asserts these exact
// values against the same frozen file.
for (const c of fixtures.tokenCases) {
  test(`stats: ${c.name}`, () => {
    assert.deepEqual(payloadStats(c.text), {
      chars: c.chars,
      lines: c.lines,
      words: c.words,
      tokens: c.tokens
    });
    // estimateTokens is the notification's token line and the name the fixture's
    // `tokens` field is generated from; keep it pinned to the same value.
    assert.equal(estimateTokens(c.text), c.tokens);
  });
}

for (const c of fixtures.parseCases) {
  test(`parse: ${c.name}`, () => {
    const parsed = parseClipboard(c.input, c.headerFormat).map(e => ({
      path: e.path,
      content: e.content,
      changeTypes: [...e.changeTypes].sort() as ChangeTypeLabel[]
    }));
    assert.deepEqual(parsed, c.expected);
  });
}

// Both REAL resolvers must send every clipboard path to the same {root, path} — or refuse
// it for the same reason. The IntelliJ mirror (ContractFixturesTest) asserts these rows
// against the same frozen file, on the same layout, so the two tools cannot drift apart.
test('path: every clipboard path resolves to the frozen cross-tool target', async t => {
  const layout = fixtures.pathLayout;
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), 'clipcode-path-contract-')));
  try {
    for (const dir of layout.dirs) await mkdir(path.join(parent, dir), { recursive: true });
    for (const [file, text] of Object.entries(layout.files)) await writeFile(path.join(parent, file), text);
    // A directory symlink needs privileges on Windows outside developer mode. Only the rows
    // that depend on it are skipped, and loudly — never the whole table.
    let symlinks = true;
    for (const [link, target] of Object.entries(layout.symlinks)) {
      try {
        await symlink(path.join(parent, target), path.join(parent, link), 'dir');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
        symlinks = false;
      }
    }
    const roots = layout.roots.map(root => path.join(parent, root));
    const outcome = (resolution: RestoreTargetResolution): PathOutcome => {
      if (resolution.ok) {
        const [root, ...rest] = path.relative(parent, resolution.absolutePath).split(path.sep);
        return { root, path: rest.join('/') };
      }
      if (resolution.reason === 'missing path') return 'missing';
      if (resolution.reason === 'ambiguous path') return 'ambiguous';
      return 'refused';
    };
    const skipped: string[] = [];
    for (const c of fixtures.pathCases) {
      if (c.needsSymlink && !symlinks) {
        skipped.push(c.input);
        continue;
      }
      const input = c.input.replaceAll('@ROOT@', roots[0]).replaceAll('@SIBLING@', roots[1]);
      await t.test(JSON.stringify(c.input), () => {
        assert.deepEqual(
          { write: outcome(resolveWriteTarget(roots, input)), delete: outcome(resolveDeleteTarget(roots, input)) },
          { write: c.write, delete: c.delete }
        );
      });
    }
    if (skipped.length > 0) {
      t.diagnostic(`SKIPPED ${skipped.length} symlink row(s): this platform refused to create a directory symlink`);
    }
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
