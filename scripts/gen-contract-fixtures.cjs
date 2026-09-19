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
const { payloadStats } = require('../out/src/copy.js');

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
  // ---- counter-examples from the 2026-09-19 interop audit -----------------------
  // These freeze what the two sides AGREE on, which is not the same as fidelity: the
  // blank-line and CRLF cases below pin a lossy round-trip, not a lossless one. They
  // are here so the loss stays identical in both tools instead of drifting apart.
  {
    name: 'regular: a path that literally starts with a change label is written as-is',
    kind: 'regular',
    options: {
      headerFormat: DEFAULT_HEADER, preText: '', postText: '', addExtraLineBetweenFiles: false,
      sourceRoot: 'myrepo',
      files: [{ path: '[DELETED] x.ts', content: 'keep me' }],
    },
  },
  {
    name: 'regular: leading and trailing blank lines are emitted verbatim (parse trims them)',
    kind: 'regular',
    options: {
      headerFormat: DEFAULT_HEADER, preText: '', postText: '', addExtraLineBetweenFiles: false,
      sourceRoot: 'myrepo',
      files: [{ path: 'src/a.ts', content: '\n  \nfoo\n\n' }],
    },
  },
  {
    name: 'regular: CRLF content is emitted verbatim (the builder never normalises endings)',
    kind: 'regular',
    options: {
      headerFormat: DEFAULT_HEADER, preText: '', postText: '', addExtraLineBetweenFiles: false,
      sourceRoot: 'myrepo',
      files: [{ path: 'src/a.ts', content: 'foo\r\nbar\r\n' }],
    },
  },
  {
    name: 'regular: a Turkish dotless i header lookalike is NOT escaped on either side',
    kind: 'regular',
    options: {
      headerFormat: DEFAULT_HEADER, preText: '', postText: '', addExtraLineBetweenFiles: false,
      sourceRoot: 'myrepo',
      files: [{ path: 'src/a.ts', content: 'before\n// f\u0131le: phantom.ts\nafter' }],
    },
  },
  {
    name: 'regular: content containing a literal end marker line is escaped',
    kind: 'regular',
    options: {
      headerFormat: DEFAULT_HEADER, preText: '', postText: '', addExtraLineBetweenFiles: false,
      sourceRoot: 'myrepo',
      files: [{ path: 'src/a.ts', content: 'before\n// clipcode-end\nafter' }],
    },
  },
  {
    name: 'git: a footer is terminated by the end marker here too',
    kind: 'git',
    options: {
      headerFormat: DEFAULT_HEADER, preText: '', postText: '</files>', addExtraLineBetweenFiles: true,
      sourceRoot: 'myrepo',
      files: [{ path: 'src/Mod.ts', content: 'modified();', changeType: 'MODIFIED' }],
    },
  },
  {
    name: 'regular: a permissive header suppresses the end marker, so a file named clipcode-end survives',
    kind: 'regular',
    options: {
      headerFormat: '// $FILE_PATH', preText: '', postText: 'FOOTER', addExtraLineBetweenFiles: false,
      files: [
        { path: 'a.ts', content: 'one' },
        { path: 'clipcode-end', content: 'KEEP' },
        { path: 'b.ts', content: 'two' }
      ],
    },
  },
  {
    name: 'regular: post text that would parse as a header is escaped',
    kind: 'regular',
    options: {
      headerFormat: DEFAULT_HEADER, preText: '', postText: '// file: fake/footer.ts', addExtraLineBetweenFiles: false,
      sourceRoot: 'myrepo',
      files: [{ path: 'src/a.ts', content: 'x();' }],
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
  // ---- counter-examples from the 2026-09-19 interop audit -----------------------
  // The footer is terminated ON THE WIRE by `// clipcode-end`. Reconstructing it from the
  // receiver's own postText setting cannot work — the two tools do not share settings, so
  // it missed exactly when it mattered (letting a footer make a size-skipped placeholder
  // body multi-line and defeat the placeholder guard) and, on a foreign payload, silently
  // deleted a real closing line.
  {
    name: 'parse: the end marker terminates the last file, whatever follows it',
    headerFormat: DEFAULT_HEADER,
    input: '// file: src/a.ts\na();\n\n// clipcode-end\n</files>',
  },
  {
    name: 'parse: a size-skipped placeholder followed by a footer stays just the placeholder',
    headerFormat: DEFAULT_HEADER,
    input: '// file: src/large.txt\n// File skipped: size exceeds limit (1100 bytes)\n\n// clipcode-end\n</files>',
  },
  {
    name: 'parse: the end marker ends that file only — a second payload still parses',
    headerFormat: DEFAULT_HEADER,
    input: '// file: src/a.ts\na();\n\n// clipcode-end\n</files>\n<files>\n// file: src/b.ts\nb();\n\n// clipcode-end\n</files>',
  },
  {
    name: 'parse: a stray end marker before any header changes nothing',
    headerFormat: DEFAULT_HEADER,
    input: '// clipcode-end\n// file: src/a.ts\na();',
  },
  {
    name: 'parse: an escaped end marker is ordinary file content',
    headerFormat: DEFAULT_HEADER,
    input: '// file: src/a.ts\nbefore\n//clipcode-esc: // clipcode-end\nafter',
  },
  {
    name: 'parse: under a permissive header the marker line is a real file, not a terminator',
    headerFormat: '// $FILE_PATH',
    input: '// a.ts\none\n// clipcode-end\nKEEP\n// b.ts\ntwo',
  },
  {
    name: 'parse: a foreign payload with no end marker keeps its real closing lines',
    headerFormat: DEFAULT_HEADER,
    input: '// file: doc.md\n# Title\n\n```js\ncode()\n```',
  },
  // The ASCII trim class. Kotlin's trim is Character.isWhitespace u isSpaceChar and JS's is
  // the ECMAScript WhiteSpace set; they disagree on U+001C-U+001F and U+FEFF. Both sides
  // now use one explicit ASCII class, so these land identically instead of producing
  // different filenames, different source roots, and different blank-line decisions.
  {
    name: 'parse: a trailing U+001C stays part of the header path',
    headerFormat: DEFAULT_HEADER,
    input: '// file: a.ts\u001C\nbody',
  },
  {
    name: 'parse: a trailing U+FEFF stays part of the header path',
    headerFormat: DEFAULT_HEADER,
    input: '// file: a.ts\uFEFF\nbody',
  },
  {
    name: 'parse: a line of only U+001C is NOT a blank line and survives trimming',
    headerFormat: DEFAULT_HEADER,
    input: '// file: a.ts\n\u001C\nfoo\n\u001C',
  },
  {
    name: 'parse: a line of only U+FEFF is NOT a blank line and survives trimming',
    headerFormat: DEFAULT_HEADER,
    input: '// file: a.ts\n\uFEFF\nfoo\n\uFEFF',
  },
  {
    name: 'parse: a bare header path keeping a leading U+001F is judged on the same bytes',
    headerFormat: DEFAULT_HEADER,
    input: 'file: \u001F"quoted.ts"\nbody',
  },
  {
    name: 'parse: the Turkish dotless i is content on both sides, never a header',
    headerFormat: DEFAULT_HEADER,
    input: '// file: src/a.ts\nbefore\n// f\u0131le: phantom.ts\nafter',
  },
  {
    name: 'parse: ASCII case-insensitivity of the generic header is preserved',
    headerFormat: DEFAULT_HEADER,
    input: '// FILE: src/a.ts\na();\n// File: src/b.ts\nb();',
  },
  {
    name: 'parse: U+0085 NEL is not a line break, so the header-like tail stays content',
    headerFormat: DEFAULT_HEADER,
    input: '// file: src/a.ts\nbefore\u0085// file: fake/inline.ts',
  },
  {
    name: 'parse: a U+FEFF before the comment marker keeps the line as content',
    headerFormat: DEFAULT_HEADER,
    input: '// file: src/a.ts\n\uFEFF// file: fake/inline.ts\nafter',
  },
  {
    name: 'parse: U+001C-U+001F inside a content line do not split it',
    headerFormat: DEFAULT_HEADER,
    input: '// file: src/a.ts\na\u001Cb\u001Dc\u001Ed\u001Fe',
  },
  // STATUS QUO, not intent: the wire format cannot express either of these, so both
  // tools lose the same information. Pinned so the loss stays symmetrical.
  {
    name: 'parse: a file whose real name starts with [DELETED] is indistinguishable on the wire',
    headerFormat: DEFAULT_HEADER,
    input: '// file: [DELETED] x.ts\nkeep me',
  },
  {
    name: 'parse: [MOVED] carries only the new path — the old one is not on the wire',
    headerFormat: DEFAULT_HEADER,
    input: '// file: [MOVED] src/new.ts\nmoved();',
  },
  {
    name: 'parse: leading blank lines are trimmed from a body too',
    headerFormat: DEFAULT_HEADER,
    input: '// file: src/a.ts\n\n  \nfoo\n\n',
  },
];

// ---- payload-statistics scenarios ----------------------------------------------
// The copy notification reports chars / lines / words / tokens, and ALL FOUR must be
// the SAME numbers in both tools for the same clipboard text. The two implementations
// (src/copy.ts payloadStats / ClipCode TokenEstimator.stats) are one shared scan, so
// the cases below target every place the two stdlibs could disagree: the whitespace
// class, the punctuation set, `\n` counting, and UTF-16 code-unit length.
const tokenInputs = [
  { name: 'empty string', text: '' },
  { name: 'ascii whitespace only', text: ' \t\n\u000B\f\r' },
  { name: 'plain words', text: 'hello world' },
  { name: 'structural punctuation attaches to its word', text: 'foo(bar);' },
  { name: 'every punctuation char counts', text: '(){}[],;' },
  // JS \s splits on these, Java \s does not - the whole reason both sides pin ASCII.
  { name: 'U+3000 ideographic space does NOT split', text: '\u4E2D\u3000\u6587' },
  { name: 'U+00A0 no-break space does NOT split', text: 'a\u00A0b' },
  { name: 'U+FEFF BOM does NOT split', text: 'a\uFEFFb' },
  { name: 'U+2028 / U+2029 line+paragraph separators do NOT split', text: 'a\u2028b\u2029c' },
  { name: 'U+2002 / U+200A en+hair spaces do NOT split', text: 'a\u2002b\u200Ac' },
  { name: 'U+1680 / U+202F / U+205F do NOT split', text: 'a\u1680b\u202Fc\u205Fd' },
  // ...and these are in BOTH ascii classes, so they must split on both sides.
  { name: 'vertical tab and form feed DO split', text: 'a\u000Bb\fc' },
  { name: 'CRLF splits once, not twice', text: 'a\r\nb' },
  { name: 'lone CR splits', text: 'a\rb' },
  { name: 'U+0085 NEL does NOT split (JS \\s has it, the ASCII class does not)', text: 'a\u0085b' },
  { name: 'U+001C-U+001F file/group/record/unit separators do NOT split', text: 'a\u001Cb\u001Db\u001Eb\u001Fb' },
  {
    name: 'realistic payload: root line, header, CJK comment, code',
    text: '// clipcode-root: myrepo\n\n// file: src/a.ts\n// \u9019\u662F\u3000\u4E2D\u6587\u8A3B\u89E3\nconst x = foo(bar, baz);\n',
  },
  // `chars` is UTF-16 code units on both sides: Kotlin String.length counts a
  // surrogate pair as 2, and so does JS. Codepoint counting on either side breaks this.
  { name: 'astral char counts as two UTF-16 code units', text: '\uD83D\uDC4D' },
  // `lines` is \n count + 1, so a trailing newline still yields a final empty line and
  // a lone CR is NOT a line break (matching the parser's \r?\n rule).
  { name: 'trailing newline still counts the final empty line', text: 'a\nb\n' },
  { name: 'CRLF counts one line break, lone CR counts none', text: 'a\r\nb\rc' },
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
  tokenCases: tokenInputs.map(i => ({ name: i.name, text: i.text, ...payloadStats(i.text) })),
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
