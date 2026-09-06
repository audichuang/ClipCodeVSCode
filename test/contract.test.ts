import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  buildGitPayload,
  buildPayload,
  parseClipboard,
  type ChangeTypeLabel,
  type PayloadFile
} from '../src/clipboardFormat.js';
import { estimateTokens, payloadStats } from '../src/copy.js';

// Shared cross-tool contract goldens — the SAME file is committed byte-identically
// in the IntelliJ repo (ClipCode/src/test/resources/clipboard-contract.json). Both
// sides assert their build + parse match these frozen bytes, so neither can drift
// from the contract without a red test. Regenerate via scripts/gen-contract-fixtures.cjs
// and update EXPECTED_FIXTURES_SHA on BOTH sides.
const EXPECTED_FIXTURES_SHA = 'fb6749cbfae24975a4eb3a8e59d180ef53239dc70dfe3afe00423530c1bb51d0';
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
interface Fixtures { buildCases: BuildCase[]; parseCases: ParseCase[]; tokenCases: TokenCase[]; }

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
