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
    // A header format with the placeholder TWICE. The builder substitutes both slots, and
    // the parser must read the pair back as ONE file whose path appears identically in
    // each slot. Both sides used to anchor on the FIRST placeholder only, so
    // `// a.ts -> a.ts` matched nothing and the whole payload parsed to zero files.
    // Pinned here because two independent unit tests are not a cross-tool contract: this
    // is the only thing that makes the two implementations agree on the same bytes.
    name: 'regular: repeated $FILE_PATH placeholders',
    kind: 'regular',
    options: {
      headerFormat: '### $FILE_PATH -> $FILE_PATH ###', preText: '', postText: '',
      addExtraLineBetweenFiles: false,
      sourceRoot: 'myrepo',
      // `$&` and `$$` are regex-replacement metacharacters; substitution is a literal
      // string replace on both sides, so they must survive verbatim in BOTH slots.
      files: [{ path: 'src/Cost$&$$plan[1].ts', content: 'x();' }],
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
    // The repeated-placeholder header, parse direction. The captured path must be reused
    // as a backreference, not re-matched loosely.
    name: 'parse: repeated $FILE_PATH placeholders read back as one file',
    headerFormat: '### $FILE_PATH -> $FILE_PATH ###',
    input: '### src/Cost$&$$plan[1].ts -> src/Cost$&$$plan[1].ts ###\nx();',
  },
  {
    // The two slots disagreeing is NOT a header — it must fall through to content, or a
    // hand-edited payload silently invents a file.
    name: 'parse: repeated $FILE_PATH placeholders reject mismatched paths',
    headerFormat: '### $FILE_PATH -> $FILE_PATH ###',
    input: '### src/a.ts -> src/b.ts ###\nx();',
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

// ---------------------------------------------------------------------------------------
// pathCases — both REAL resolvers, one fixed on-disk layout, the same clipboard path.
//
// Restore is only interoperable if every clipboard path lands on the SAME target in both
// tools (or both refuse it). These rows began as a one-off differential of the two real
// resolvers (2026-09-23), which found the `.`-in-regex and control-character divergences;
// committing them is what keeps that true instead of merely true-once.
//
// Expectations are {root, path} with `/` separators — never absolute, and never `existed`,
// which depends on whether the filesystem is case-sensitive. Rows whose answer legitimately
// depends on the platform are NOT here: a POSIX-style path whose segment differs from a root
// name only by case matches on Windows (whose `C:/…` roots make every suffix comparison
// case-insensitive) and not on Linux. Both tools agree on each platform; no single golden
// value can describe all three, so such a row would be a false alarm, not a contract.
// @ROOT@ / @SIBLING@ are replaced by each side with its own absolute root paths.
// Outcomes: a target, or 'refused' | 'missing' | 'ambiguous' (Kotlin Unresolved | Missing |
// Ambiguous ↔ VS Code 'unsafe path'/'outside workspace' | 'missing path' | 'ambiguous path').
const pathLayout = {
  roots: ['project', 'backup'], // the first is the primary root
  dirs: ['project', 'backup', 'outside', 'project/D'],
  files: { 'project/D/keep.txt': 'keep' },
  symlinks: { 'project/escaped': 'outside' },
};
const SYMLINK = { needsSymlink: true };
const pathInputs = [
  'D:\\Users\\author\\.m2\\repository\\library.jar!\\com\\example\\Library$Inner.java',
  '/foreign/checkout/src/New.kt', '\\\\server\\share\\arbitrary\\New.txt', '/etc/passwd',
  'D:/foreign/../secret.txt', '/foreign/../secret.txt', 'D:/foreign/bad:name.txt',
  '/backup/backup/new.txt', '/unmapped/source.txt',
  'D:/', 'D:\\', 'D:', '/', '//', 'D:relative-drive.txt',
  // Line terminators: U+0085/U+2028/U+2029 are legal names everywhere (`[\s\S]`, not `.`);
  // \r and \n are control characters and refused everywhere.
  'D:/a\rb.txt', 'D:/a\u0085b.txt', 'D:/a\u2028b.txt', 'D:/a\u2029b.txt', 'D:/a\nb.txt',
  'D:\\a\nb.txt', 'D:\\a\rb.txt', 'D:\\a\u2028b.txt', 'D:\\a\u0085b.txt',
  '/a\rb.txt', '/a\u0085b.txt', '/a\u2028b.txt', '/a\tb.txt', '/a\u0000b.txt', 'D:\\a\tb.txt',
  'd:/lower/x.txt', 'D://double//slash.txt', '//double/leading.txt',
  '/Users/bob/other/src/a.ts', 'C:/Users/bob/other/src/a.ts',
  '/elsewhere/project/src/x.ts', '/elsewhere/backup/y.ts', 'D:/elsewhere/PROJECT/z.ts',
  'D:/elsewhere/PROJECT/a\rb.ts', 'D:/elsewhere/PROJECT/a\u0085b.ts',
  'D:/elsewhere/PROJECT/a\u2028b.ts', 'D:/elsewhere/PROJECT/a\u2029b.ts',
  '/x/./y.txt', '/dir/', '  /spaced/path.txt  ', '\t/tabbed.txt',
  '/a\u3000b.txt', '\u00A0/nbsp.txt', '\uFEFF/bom.txt', '\u001C/fs-lead.txt',
  '/a.txt\u001C', 'D:/x/y\u001C', '/seg/\u001C/z.txt',
  { input: '/escaped/new.txt', ...SYMLINK }, { input: '/escaped/deeper/new.txt', ...SYMLINK },
  '/D/keep.txt', 'D:/keep.txt',
  'relative/ok.txt', 'backup/rel.txt', '../up.txt', 'src/bad:name.ts',
  '/a/b<c>.txt', '/q/what?.txt', '/😀/emoji.txt', 'D:/Ünïcode/файл.txt', '/foo\\bar.txt',
  '@ROOT@/src/in-root.ts', '@ROOT@/../outside/x.txt', '@SIBLING@/z.txt', '@ROOT@',
  '/project/src/lead-seg.ts', '/backup/lead.ts',
].map(row => (typeof row === 'string' ? { input: row } : row));

function computePathCases() {
  const os = require('node:os');
  const { resolveWriteTarget, resolveDeleteTarget } = require('../out/src/pathResolver.js');
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clipcode-path-cases-')));
  try {
    for (const dir of pathLayout.dirs) fs.mkdirSync(path.join(parent, dir), { recursive: true });
    for (const [file, text] of Object.entries(pathLayout.files)) fs.writeFileSync(path.join(parent, file), text);
    for (const [link, target] of Object.entries(pathLayout.symlinks)) {
      fs.symlinkSync(path.join(parent, target), path.join(parent, link), 'dir');
    }
    const roots = pathLayout.roots.map(root => path.join(parent, root));
    const outcome = resolution => {
      if (resolution.ok) {
        const [root, ...rest] = path.relative(parent, resolution.absolutePath).split(path.sep);
        return { root, path: rest.join('/') };
      }
      return { 'missing path': 'missing', 'ambiguous path': 'ambiguous' }[resolution.reason] ?? 'refused';
    };
    return pathInputs.map(row => {
      const input = row.input.replaceAll('@ROOT@', roots[0]).replaceAll('@SIBLING@', roots[1]);
      return { ...row, write: outcome(resolveWriteTarget(roots, input)), delete: outcome(resolveDeleteTarget(roots, input)) };
    });
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------
// restoreCases — a payload + a fixed on-disk layout → the PLAN both tools build before
// anything is written: which files are created (with what content, and whether one already
// existed), deleted, or skipped and why. Every cross-tool DECISION a paste makes lives in the
// plan; writing the bytes is covered by each side's own executor tests and e2e. Paths are
// {root, path} with `/`, never absolute. Skip reasons are normalised: VS Code's AMBIGUOUS_PATH
// and IntelliJ's AMBIGUOUS_TARGET are one outcome, AMBIGUOUS.
const restoreLayout = {
  roots: ['project', 'backup'],
  dirs: ['project/src', 'backup', 'outside'],
  files: {
    'project/src/existing.ts': { text: 'old\n' },
    'project/src/to-delete.ts': { text: 'bye\n' },
    'project/latin1.txt': { base64: Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]).toString('base64') }, // "café" in latin-1
    'project/bom.txt': { base64: Buffer.from('\uFEFFhi\n', 'utf8').toString('base64') },
    'backup/b.ts': { text: 'b\n' },
    'outside/secret.txt': { text: 'must never be deleted\n' },
  },
  symlinks: { 'project/escaped': 'outside' },
};
const H = '// file: $FILE_PATH';
const restoreInputs = [
  { name: 'new files, nested directories included', headerFormat: H,
    payload: '// file: src/new/A.ts\nexport const a = 1;\n\n// file: README.md\n# hi' },
  { name: 'overwriting a file that exists reports existed', headerFormat: H,
    payload: '// file: src/existing.ts\nnew content' },
  { name: '[DELETED] removes an existing file and skips one that is already gone', headerFormat: H,
    payload: '// file: [DELETED] src/to-delete.ts\nbye\n\n// file: [DELETED] src/ghost.ts\ngone' },
  { name: 'placeholder bodies are never written, over an existing file or a new one', headerFormat: H,
    payload: '// file: src/existing.ts\n// File skipped: size exceeds limit\n\n' +
      '// file: src/new-unreadable.ts\n// Unable to read file content\n\n' +
      '// file: src/new-error.ts\n// Error reading file content' },
  { name: 'the placeholder guard reads only the first line of the body', headerFormat: H,
    payload: '// file: src/existing.ts\n// File skipped: size exceeds limit\ntrailing footer noise' },
  { name: 'a non-UTF-8 target is never overwritten; a UTF-8 one with a BOM is', headerFormat: H,
    payload: '// file: latin1.txt\ncafé\n\n// file: bom.txt\n\uFEFFhello' },
  // Writing AND deleting through a directory symlink that points out of the workspace. The
  // delete target really exists outside, so this is refused by containment — never deleted,
  // and never mis-reported as ALREADY_ABSENT.
  { name: 'a path escaping through a symlink is refused, for a write and for a delete', headerFormat: H, needsSymlink: true,
    payload: '// file: escaped/x.txt\nx\n\n// file: [DELETED] escaped/secret.txt\ngone' },
  { name: 'an absolute path matching no root is kept literally under the primary root', headerFormat: H,
    payload: '// file: /Users/bob/other/src/a.ts\nx\n\n// file: D:\\work\\lib\\b.ts\ny' },
  { name: 'a sibling root label targets that root', headerFormat: H,
    payload: '// file: backup/c.ts\nc\n\n// file: backup/b.ts\nb2' },
  { name: 'traversal, Windows-illegal characters and control characters are refused', headerFormat: H,
    payload: '// file: ../escape.txt\nx\n\n// file: src/bad:name.ts\nx\n\n// file: src/a\u001Cb.ts\nx\n\n// file: src/tab\tname.ts\nx' },
  { name: 'backslash header paths are ordinary separators', headerFormat: H,
    payload: '// file: src\\win\\A.ts\nwin' },
  { name: 'labels are stripped from the target path', headerFormat: H,
    payload: '// file: [NEW] src/n.ts\nn\n\n// file: [MODIFIED] src/existing.ts\nm\n\n// file: [MOVED] src/moved.ts\nmv' },
  { name: 'CRLF line endings, a BOM and an empty file', headerFormat: H,
    payload: '// file: src/crlf.ts\r\nline1\r\nline2\r\n\r\n// file: src/bom.ts\n\uFEFFbom\n\n// file: src/empty.ts\n' },
  { name: 'the same path twice is planned twice, in order', headerFormat: H,
    payload: '// file: src/dup.ts\nfirst\n\n// file: src/dup.ts\nsecond' },
  { name: 'a header-shaped content line round-trips, clipcode-root and the end marker are not files',
    headerFormat: H,
    payload: fmt.buildPayload({ headerFormat: H, preText: 'PRE', postText: 'POST', addExtraLineBetweenFiles: true,
      sourceRoot: 'project', files: [
        { path: 'src/escaped.ts', content: 'const a = 1;\n// file: not/a/header.ts\nconst b = 2;' },
        { path: 'src/last.ts', content: 'last' },
      ] }) },
  { name: 'another header format', headerFormat: '# $FILE_PATH',
    payload: '# src/py.py\nprint(1)\n\n# [DELETED] src/to-delete.ts\nx' },
];

async function computeRestoreCases() {
  const os = require('node:os');
  const { planRestore } = require('../out/src/restore.js');
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clipcode-restore-cases-')));
  try {
    for (const dir of restoreLayout.dirs) fs.mkdirSync(path.join(parent, dir), { recursive: true });
    for (const [file, spec] of Object.entries(restoreLayout.files)) {
      fs.writeFileSync(path.join(parent, file), spec.base64 !== undefined ? Buffer.from(spec.base64, 'base64') : spec.text);
    }
    for (const [link, target] of Object.entries(restoreLayout.symlinks)) {
      fs.symlinkSync(path.join(parent, target), path.join(parent, link), 'dir');
    }
    const roots = restoreLayout.roots.map(root => path.join(parent, root));
    const where = absolutePath => {
      const [root, ...rest] = path.relative(parent, absolutePath).split(path.sep);
      return { root, path: rest.join('/') };
    };
    const reason = r => (r === 'AMBIGUOUS_PATH' || r === 'AMBIGUOUS_TARGET' ? 'AMBIGUOUS' : r);
    const cases = [];
    for (const input of restoreInputs) {
      const entries = fmt.parseClipboard(input.payload, input.headerFormat);
      const plan = await planRestore(roots, entries);
      cases.push({
        ...input,
        creates: plan.createOperations.map(op => ({ ...where(op.absolutePath), relativePath: op.relativePath, content: op.content, existed: op.existed })),
        deletes: plan.deleteOperations.map(op => ({ ...where(op.absolutePath), relativePath: op.relativePath })),
        skips: plan.skippedOperations.map(op => ({ rawPath: op.rawPath, relativePath: op.relativePath ?? null, reason: reason(op.reason) })),
      });
    }
    return cases;
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
}

// ---- non-text files (spec non-text-files.md, required cases 1-7, 12, 18) -----------------
// nonTextBuildCases: files with `base64` are non-text (raw bytes), files with `content` are
// text. nonTextRestoreCases: a payload planned against an EMPTY directory — creates are
// {path, base64} for non-text and {path, content} for text, skips {rawPath, reason}. The
// inputs are authored here; only the wire/plan come from the real build/restore code.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQ=';
const SHAPED_B64 = 'AAIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyAhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5ADs8PT4/QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl9gYWJjZGVmZ2hpamtsbW5vcHFyAHR1dnd4eXp7fH1+f4CBgg==';
const PNG_SHA = '3067f3a1a846d709d1b4aa1e3226be6fd0227a2c2343a0be64ee2be2ef646f90';
const PH_TEXT = '// File skipped: non-text file, 3 bytes, sha256 47ffa3ea45a70b8a41c2c0825df323c00a8b7a01c1ea06083cc41dddcc001123; base64 follows';
const PH_FAKE = '// File skipped: non-text file, 3 bytes, sha256 039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81; base64 follows';
const MIXED_FILES = [
  { path: 'a.bin', base64: 'AAECA//+' },
  { path: 't1.txt', content: `${PH_TEXT}\nYWJj` },
  { path: 't2.txt', content: `//clipcode-esc: ${PH_TEXT}\nline two` },
];
const SHAPED_FILES = [
  { path: 'img/shaped.bin', base64: SHAPED_B64 },
  { path: 't1.txt', content: `${PH_TEXT}\nYWJj` },
];
const nonTextBuildInputs = [
  { name: 'PNG with NUL bytes, wrapped at 76', headerFormat: H,
    files: [{ path: 'public/static/logo.png', base64: PNG_B64 }] },
  { name: 'Big5 text (no NUL, invalid UTF-8) is a non-text file', headerFormat: H,
    files: [{ path: 'legacy/big5.txt', base64: 'pKSk5bT6uNUK' }, { path: 'src/a.ts', content: 'const a = 1;' }] },
  { name: '1-byte 0x00 file is non-text; an empty file stays a text entry', headerFormat: H,
    files: [{ path: 'nul.bin', base64: 'AA==' }, { path: 'empty.txt', content: '' }] },
  { name: 'header-shaped Base64 lines under a custom headerFormat are escaped', headerFormat: 'A$FILE_PATH',
    files: [{ path: 'img/shaped.bin', base64: SHAPED_B64 }] },
  { name: 'a text file whose first line looks like a non-text placeholder is escaped', headerFormat: H,
    files: [{ path: 'fake.txt', content: `${PH_FAKE}\nAQID` }] },
  { name: 'build: non-text file, placeholder-shaped text with Base64 second line, and ESC-prefixed placeholder text (built-in header)', headerFormat: H,
    files: MIXED_FILES },
  { name: 'build: same under a header format that matches the placeholder line itself', headerFormat: '// $FILE_PATH',
    files: MIXED_FILES },
  { name: 'build: Base64 lines header-shaped under A$FILE_PATH next to placeholder-shaped text', headerFormat: 'A$FILE_PATH',
    files: SHAPED_FILES },
  { name: 'build: a whitespace-only first line that the header format matches is escaped; the placeholder escape goes on the next, first non-blank, line', headerFormat: ' $FILE_PATH',
    files: [{ path: 't.txt', content: `   \n${PH_FAKE}\nAQID` }] },
];

function nonTextWire(input) {
  const files = input.files.map(f =>
    f.base64 !== undefined ? { path: f.path, nonText: new Uint8Array(Buffer.from(f.base64, 'base64')) } : { path: f.path, content: f.content });
  return fmt.buildPayload({ headerFormat: input.headerFormat, preText: '', postText: '', addExtraLineBetweenFiles: true, files });
}
const wireOf = i => nonTextWire(nonTextBuildInputs[i]);
const PNG_PLACEHOLDER = `// File skipped: non-text file, 83 bytes, sha256 ${PNG_SHA}; base64 follows`;
const PNG_LINE_1 = PNG_B64.slice(0, 76);
const PNG_LINE_2 = PNG_B64.slice(76);
const OK_FILE = '\n// file: src/ok.ts\nok\n\n';
const nonTextRestoreInputs = [
  { name: 'round trip: PNG with NUL bytes, wrapped at 76', headerFormat: H, payload: wireOf(0) },
  { name: 'round trip: Big5 text (no NUL, invalid UTF-8) is a non-text file', headerFormat: H, payload: wireOf(1) },
  { name: 'round trip: 1-byte 0x00 file is non-text; an empty file stays a text entry', headerFormat: H, payload: wireOf(2) },
  { name: 'round trip: header-shaped Base64 lines under a custom headerFormat are escaped', headerFormat: 'A$FILE_PATH', payload: wireOf(3) },
  { name: 'CRLF line endings (Windows clipboard) still decode', headerFormat: H, payload: wireOf(0).replace(/\n/g, '\r\n') },
  { name: 'spaces and tabs around Base64 lines are ignored', headerFormat: H,
    payload: `\n// file: loose.png\n${PNG_PLACEHOLDER}\n ${PNG_LINE_1} \t\n ${PNG_LINE_2} \t\n\n` },
  { name: 'truncated Base64 skips only that file', headerFormat: H,
    payload: `\n// file: trunc.png\n${PNG_PLACEHOLDER}\n${PNG_LINE_1}\n${PNG_LINE_2.slice(0, -4)}\n${OK_FILE}` },
  { name: 'wrong SHA-256 skips only that file', headerFormat: H,
    payload: `\n// file: sha.png\n${PNG_PLACEHOLDER.replace(PNG_SHA, '0'.repeat(64))}\n${PNG_LINE_1}\n${PNG_LINE_2}\n${OK_FILE}` },
  { name: 'wrong size skips the file', headerFormat: H,
    payload: `\n// file: size.png\n${PNG_PLACEHOLDER.replace(' 83 bytes', ' 84 bytes')}\n${PNG_LINE_1}\n${PNG_LINE_2}\n\n` },
  { name: 'a non-text file over its limit is a size placeholder', headerFormat: H,
    payload: '\n// file: img/huge.png\n// File skipped: size exceeds limit (3000000 bytes)\n\n' },
  { name: 'round trip: a text file whose first line looks like a non-text placeholder restores as that text', headerFormat: H, payload: wireOf(4) },
  { name: 'round trip: non-text file, placeholder-shaped text with Base64 second line, and ESC-prefixed placeholder text (built-in header)', headerFormat: H, payload: wireOf(5) },
  { name: 'round trip: same under a header format that matches the placeholder line itself', headerFormat: '// $FILE_PATH', payload: wireOf(6) },
  { name: 'round trip: Base64 lines header-shaped under A$FILE_PATH next to placeholder-shaped text', headerFormat: 'A$FILE_PATH', payload: wireOf(7) },
  { name: 'round trip: placeholder escape on the first non-blank line after an escaped whitespace-only line', headerFormat: ' $FILE_PATH', payload: wireOf(8) },
];

async function computeNonTextRestoreCases() {
  const os = require('node:os');
  const { planRestore } = require('../out/src/restore.js');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'clipcode-nontext-cases-')));
  try {
    const cases = [];
    for (const input of nonTextRestoreInputs) {
      const plan = await planRestore([root], fmt.parseClipboard(input.payload, input.headerFormat));
      cases.push({
        ...input,
        creates: plan.createOperations.map(op => op.nonText
          ? { path: op.relativePath, base64: Buffer.from(op.nonText.bytes).toString('base64') }
          : { path: op.relativePath, content: op.content }),
        skips: plan.skippedOperations.map(op => ({ rawPath: op.rawPath, reason: op.reason })),
      });
    }
    return cases;
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

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
    'Regenerate and copy to both repos; update EXPECTED_FIXTURES_SHA on both sides. ' +
    'nonTextBuildCases and nonTextRestoreCases come from OpenIDEA crates/ide-clip ' +
    '(docs/clipcode/non-text-files.md, required test cases 1-7).',
  buildCases: buildInputs.map(i => ({ name: i.name, kind: i.kind, options: i.options, wire: buildWire(i) })),
  parseCases: parseInputs.map(i => ({ name: i.name, headerFormat: i.headerFormat, input: i.input, expected: parseExpected(i) })),
  tokenCases: tokenInputs.map(i => ({ name: i.name, text: i.text, ...payloadStats(i.text) })),
  pathLayout,
  pathCases: computePathCases(),
  restoreLayout,
};

(async () => {
fixtures.restoreCases = await computeRestoreCases();
fixtures.nonTextBuildCases = nonTextBuildInputs.map(i => ({ name: i.name, headerFormat: i.headerFormat, files: i.files, wire: nonTextWire(i) }));
fixtures.nonTextRestoreCases = await computeNonTextRestoreCases();
const json = JSON.stringify(fixtures, null, 2) + '\n';
const vscodeOut = path.join(__dirname, '..', 'test', 'fixtures', 'clipboard-contract.json');
fs.mkdirSync(path.dirname(vscodeOut), { recursive: true });
// CLIPCODE_FIXTURE_CHECK=1: compare only. The generated JSON goes to a temp file and the
// committed fixture is left untouched, so a run that cannot match (for example while the
// restore planner does not know non-text entries yet) can never overwrite the shared bytes.
if (process.env.CLIPCODE_FIXTURE_CHECK) {
  const committed = fs.readFileSync(vscodeOut, 'utf8');
  const tmpOut = path.join(require('node:os').tmpdir(), 'clipboard-contract.generated.json');
  fs.writeFileSync(tmpOut, json);
  if (committed === json) {
    console.log('fixture check: generated output is byte-identical to the committed fixture');
  } else {
    const a = JSON.parse(committed);
    const differing = Object.keys({ ...a, ...fixtures }).filter(k => JSON.stringify(a[k]) !== JSON.stringify(fixtures[k]));
    console.log('fixture check: MISMATCH in sections:', differing.join(', ') || '(formatting only)');
    console.log('generated output written to', tmpOut);
    process.exitCode = 1;
  }
  return;
}
fs.writeFileSync(vscodeOut, json);

const crypto = require('node:crypto');
const sha = crypto.createHash('sha256').update(json).digest('hex');
console.log('Wrote', vscodeOut);
console.log('SHA-256:', sha);
console.log('Copy this file to: ClipCode/src/test/resources/clipboard-contract.json');
console.log('Set EXPECTED_FIXTURES_SHA =', sha, 'in both contract tests.');
})().catch(error => { console.error(error); process.exit(1); });
