#!/usr/bin/env node
// Generates the shared cross-tool clipboard-contract golden fixtures.
//
// The VS Code implementation is the format AUTHORITY (see AGENTS.md). This script
// feeds authored scenarios through the compiled clipboardFormat.js and freezes the
// resulting wire bytes (build direction) and parse results (parse direction) into a
// JSON file that is committed BYTE-IDENTICALLY into BOTH repos:
//   - ClipCodeVSCode/test/fixtures/clipboard-contract.json
//   - ClipCode/src/test/resources/clipboard-contract.json
// Each side's contract test then asserts its own build+parse matches this golden, so
// neither side can drift from the frozen contract without a red test.
//
// Run:  npm run compile && node scripts/gen-contract-fixtures.cjs
// After running, copy the JSON into the IntelliJ repo (the script prints the path).

const fs = require('node:fs');
const path = require('node:path');
const fmt = require('../out/src/clipboardFormat.js');

const DEFAULT_HEADER = '// file: $FILE_PATH';

// ---- build-direction scenarios -------------------------------------------------
// kind: 'regular' -> buildPayload (empty wrappers kept); 'git' -> buildGitPayload.
const buildInputs = [
  {
    name: 'regular: single file, single root metadata, default header',
    kind: 'regular',
    options: {
      headerFormat: DEFAULT_HEADER, preText: '', postText: '', addExtraLineBetweenFiles: false,
      sourceRoot: 'myrepo',
      files: [{ path: 'src/a.ts', content: 'const x = 1;' }],
    },
  },
  {
    name: 'regular: two files with blank line between',
    kind: 'regular',
    options: {
      headerFormat: DEFAULT_HEADER, preText: '', postText: '', addExtraLineBetweenFiles: true,
      sourceRoot: 'myrepo',
      files: [
        { path: 'src/a.ts', content: 'a();' },
        { path: 'src/b.ts', content: 'b();' },
      ],
    },
  },
  {
    name: 'regular: non-empty pre/post text',
    kind: 'regular',
    options: {
      headerFormat: DEFAULT_HEADER, preText: 'BEFORE', postText: 'AFTER', addExtraLineBetweenFiles: false,
      sourceRoot: 'myrepo',
      files: [{ path: 'src/a.ts', content: 'x();' }],
    },
  },
  {
    name: 'regular: no source root -> no metadata line',
    kind: 'regular',
    options: {
      headerFormat: DEFAULT_HEADER, preText: '', postText: '', addExtraLineBetweenFiles: false,
      files: [{ path: 'src/a.ts', content: 'x();' }],
    },
  },
  {
    name: 'regular: content containing an inline header line is escaped',
    kind: 'regular',
    options: {
      headerFormat: DEFAULT_HEADER, preText: '', postText: '', addExtraLineBetweenFiles: false,
      sourceRoot: 'myrepo',
      files: [{ path: 'src/a.ts', content: 'before\n// file: fake/inline.ts\nafter' }],
    },
  },
  {
    name: 'regular: content containing a literal escape marker is double-escaped',
    kind: 'regular',
    options: {
      headerFormat: DEFAULT_HEADER, preText: '', postText: '', addExtraLineBetweenFiles: false,
      sourceRoot: 'myrepo',
      files: [{ path: 'src/a.ts', content: '//clipcode-esc: // file: x.ts' }],
    },
  },
  {
    name: 'regular: custom header format',
    kind: 'regular',
    options: {
      headerFormat: '### $FILE_PATH ###', preText: '', postText: '', addExtraLineBetweenFiles: false,
      sourceRoot: 'myrepo',
      files: [{ path: 'src/a.ts', content: 'x();' }],
    },
  },
  {
    name: 'regular: permissive header format suppresses the metadata line',
    kind: 'regular',
    options: {
      headerFormat: '$FILE_PATH', preText: '', postText: '', addExtraLineBetweenFiles: false,
      sourceRoot: 'myrepo',
      files: [{ path: 'src/a.ts', content: 'x();' }],
    },
  },
  {
    name: 'regular: path containing $ dollar patterns is inserted verbatim',
    kind: 'regular',
    options: {
      headerFormat: DEFAULT_HEADER, preText: '', postText: '', addExtraLineBetweenFiles: false,
      sourceRoot: 'myrepo',
      files: [{ path: 'src/weird$&$$name.ts', content: 'x();' }],
    },
  },
  {
    name: 'regular: full-width-space-indented header-like content line is NOT escaped',
    kind: 'regular',
    options: {
      headerFormat: DEFAULT_HEADER, preText: '', postText: '', addExtraLineBetweenFiles: false,
      sourceRoot: 'myrepo',
      files: [{ path: 'src/a.ts', content: '　// file: fake/inline.ts' }],
    },
  },
  {
    name: 'regular: empty-string source root is treated as absent (no metadata line)',
    kind: 'regular',
    options: {
      headerFormat: DEFAULT_HEADER, preText: '', postText: '', addExtraLineBetweenFiles: false,
      sourceRoot: '',
      files: [{ path: 'src/a.ts', content: 'x();' }],
    },
  },
  {
    name: 'git: empty-string skippedReason falls through to content',
    kind: 'git',
    options: {
      headerFormat: DEFAULT_HEADER, preText: '', postText: '', addExtraLineBetweenFiles: false,
      sourceRoot: 'myrepo',
      files: [{ path: 'src/a.ts', content: 'real();', skippedReason: '', changeType: 'MODIFIED' }],
    },
  },
  {
    name: 'git: modified file with content plus a deleted marker',
    kind: 'git',
    options: {
      headerFormat: DEFAULT_HEADER, preText: '', postText: '', addExtraLineBetweenFiles: false,
      sourceRoot: 'myrepo',
      files: [
        { path: 'src/Mod.ts', content: 'modified();', changeType: 'MODIFIED' },
        { path: 'src/Gone.ts', content: '// This file has been deleted in this change', changeType: 'DELETED' },
      ],
    },
  },
  {
    name: 'git: file skipped for size',
    kind: 'git',
    options: {
      headerFormat: DEFAULT_HEADER, preText: '', postText: '', addExtraLineBetweenFiles: false,
      sourceRoot: 'myrepo',
      files: [{ path: 'src/Big.ts', skippedReason: 'size exceeds limit (2048 bytes)', changeType: 'MODIFIED' }],
    },
  },
  {
    name: 'git: deleted marker under a permissive header is escaped',
    kind: 'git',
    options: {
      headerFormat: '// $FILE_PATH', preText: '', postText: '', addExtraLineBetweenFiles: false,
      sourceRoot: 'myrepo',
      files: [{ path: 'src/Gone.ts', content: '// This file has been deleted in this change', changeType: 'DELETED' }],
    },
  },
];

// ---- parse-direction scenarios -------------------------------------------------
const parseInputs = [
  {
    name: 'parse: two files, default header',
    headerFormat: DEFAULT_HEADER,
    input: '// file: src/a.ts\na();\n// file: src/b.ts\nb();',
  },
  {
    name: 'parse: leading clipcode-root metadata line is dropped',
    headerFormat: DEFAULT_HEADER,
    input: '// clipcode-root: myrepo\n// file: src/a.ts\na();',
  },
  {
    name: 'parse: escaped inline header round-trips to literal content',
    headerFormat: DEFAULT_HEADER,
    input: '// file: src/a.ts\nbefore\n//clipcode-esc: // file: fake/inline.ts\nafter',
  },
  {
    name: 'parse: DELETED label with old content still parses as deleted',
    headerFormat: DEFAULT_HEADER,
    input: '// file: [DELETED] src/Old.ts\nfunction legacy() {}',
  },
  {
    name: 'parse: multiple leading labels MOVED + DELETED',
    headerFormat: DEFAULT_HEADER,
    input: '// file: [MOVED] [DELETED] src/Moved.ts\n',
  },
  {
    name: 'parse: bare header without comment prefix',
    headerFormat: DEFAULT_HEADER,
    input: 'file: src/a.ts\nx();',
  },
  {
    name: 'parse: custom header format',
    headerFormat: '### $FILE_PATH ###',
    input: '### file: [MODIFIED] src/App.kt ###\nfun main() = Unit',
  },
  {
    name: 'parse: CRLF line endings are tolerated',
    headerFormat: DEFAULT_HEADER,
    input: '// file: src/a.ts\r\nline1\r\nline2',
  },
  {
    name: 'parse: a lone CR inside content is NOT a line break (strict mirror)',
    headerFormat: DEFAULT_HEADER,
    input: '// file: src/a.ts\nconst x = 1;\rconst y = 2;',
  },
  {
    name: 'parse: interior and trailing blank lines',
    headerFormat: DEFAULT_HEADER,
    input: '// file: src/a.ts\nline1\n\nline2\n\n',
  },
  {
    name: 'parse: full-width-space-indented header-like line stays content (ASCII ws)',
    headerFormat: DEFAULT_HEADER,
    input: '// file: src/a.ts\n　// file: fake/inline.ts\nafter',
  },
  {
    name: 'parse: permissive header still drops the metadata line',
    headerFormat: '// $FILE_PATH',
    input: '// clipcode-root: myrepo\n// src/a.ts\nx();',
  },
];

function buildWire(input) {
  return input.kind === 'git' ? fmt.buildGitPayload(input.options) : fmt.buildPayload(input.options);
}

function parseExpected(input) {
  return fmt.parseClipboard(input.input, input.headerFormat).map(e => ({
    path: e.path,
    content: e.content,
    changeTypes: [...e.changeTypes].sort(),
  }));
}

const fixtures = {
  _comment: 'AUTO-GENERATED by ClipCodeVSCode/scripts/gen-contract-fixtures.cjs. ' +
    'Frozen cross-tool contract goldens, committed byte-identically in both repos. ' +
    'Regenerate and copy to both repos; update EXPECTED_FIXTURES_SHA on both sides.',
  buildCases: buildInputs.map(i => ({ name: i.name, kind: i.kind, options: i.options, wire: buildWire(i) })),
  parseCases: parseInputs.map(i => ({ name: i.name, headerFormat: i.headerFormat, input: i.input, expected: parseExpected(i) })),
};

const json = JSON.stringify(fixtures, null, 2) + '\n';
const vscodeOut = path.join(__dirname, '..', 'test', 'fixtures', 'clipboard-contract.json');
fs.mkdirSync(path.dirname(vscodeOut), { recursive: true });
fs.writeFileSync(vscodeOut, json);

const crypto = require('node:crypto');
const sha = crypto.createHash('sha256').update(json).digest('hex');
console.log('Wrote', vscodeOut);
console.log('SHA-256:', sha);
console.log('Copy this file to: ClipCode/src/test/resources/clipboard-contract.json');
console.log('Set EXPECTED_FIXTURES_SHA =', sha, 'in both contract tests.');
