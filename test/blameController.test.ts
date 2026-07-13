import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import Module from 'node:module';
import { after, beforeEach, test } from 'node:test';
import type { BlameLine } from '../src/blame/blameParser.js';

class MarkdownString {
  isTrusted: boolean | { enabledCommands: readonly string[] } | undefined;
  value = '';
  appendMarkdown(markdown: string): this { this.value += markdown; return this; }
}

class ThemeColor { constructor(readonly id: string) {} }
class Range { constructor(..._args: number[]) {} }

class FakeStream extends EventEmitter {
  setEncoding(_encoding: string): void {}
  end(_contents?: string): void {}
}

class BlameProcess extends EventEmitter {
  readonly stdout = new FakeStream();
  readonly stdin = new FakeStream();
  killed = false;

  succeed(stdout: string): void {
    this.stdout.emit('data', stdout);
    this.emit('close', 0);
  }

  fail(): void {
    this.emit('close', 1);
  }

  kill(): void {
    this.killed = true;
  }
}

const processes: BlameProcess[] = [];
let decorationId = 0;
const decorationOptions: Array<{ before?: { color?: ThemeColor } }> = [];
const vscode = {
  MarkdownString,
  ThemeColor,
  Range,
  window: {
    activeTextEditor: undefined as TestEditor | undefined,
    visibleTextEditors: [] as TestEditor[],
    createTextEditorDecorationType: (options: { before?: { color?: ThemeColor } }) => {
      decorationOptions.push(options);
      return { id: decorationId++, dispose() {} };
    },
    showInformationMessage: () => Promise.resolve(undefined),
  },
};

const loader = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
};
const originalLoad = loader._load;
loader._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscode;
  if (request === 'node:child_process') {
    return {
      spawn: () => {
        const child = new BlameProcess();
        processes.push(child);
        return child;
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};

const controllerModule = import('../src/blame/blameController.js');

interface TestDocument {
  uri: { fsPath: string; toString(): string };
  version: number;
  lineCount: number;
  getText(): string;
}

interface TestDecoration {
  renderOptions?: { before?: { contentText?: string } };
  hoverMessage?: MarkdownString;
}

interface TestEditor {
  document: TestDocument;
  viewColumn: number;
  decorations: Map<unknown, TestDecoration[]>;
  setDecorations(type: unknown, options: TestDecoration[]): void;
}

function makeDocument(file = '/repo/file.ts'): TestDocument {
  return {
    uri: { fsPath: file, toString: () => `file://${file}` },
    version: 1,
    lineCount: 1,
    getText: () => 'const value = 1;',
  };
}

function makeEditor(document = makeDocument(), viewColumn = 1): TestEditor {
  const decorations = new Map<unknown, TestDecoration[]>();
  return {
    document,
    viewColumn,
    decorations,
    setDecorations(type, options) { decorations.set(type, options); },
  };
}

function blameOutput(author: string, sha: string): string {
  return `${sha} 1 1 1\nauthor ${author}\nauthor-time 1\nsummary change\n\tconst value = 1;\n`;
}

function labels(editor: TestEditor): string[] {
  return [...editor.decorations.values()]
    .flat()
    .flatMap(option => option.renderOptions?.before?.contentText ?? []);
}

function authors(editor: TestEditor): string[] {
  return labels(editor).map(label => label.split(' · ')[0]);
}

async function waitForProcess(count: number): Promise<void> {
  for (let i = 0; i < 100 && processes.length < count; i++) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  assert.equal(processes.length, count);
}

beforeEach(() => {
  processes.length = 0;
  decorationOptions.length = 0;
  vscode.window.activeTextEditor = undefined;
  vscode.window.visibleTextEditors = [];
});

test('each blame age bucket uses a distinct theme color', async () => {
  const { BlameController } = await controllerModule;
  const controller = new BlameController({
    getGitPath: () => 'git',
    resolveRepoRoot: () => undefined,
  });

  const colorIds = decorationOptions.map(options => options.before?.color?.id);
  assert.equal(colorIds.length, 5);
  assert.equal(new Set(colorIds).size, 5);
  controller.dispose();
});

test('git API readiness retries blame enabled before vscode.git activation completed', async () => {
  const { BlameController } = await controllerModule;
  const editor = makeEditor();
  vscode.window.activeTextEditor = editor;
  vscode.window.visibleTextEditors = [editor];
  let ready = false;
  const controller = new BlameController({
    getGitPath: () => 'git',
    resolveRepoRoot: () => ready ? { repoRoot: '/repo', head: 'HEAD' } : undefined,
  });

  await controller.toggle();
  assert.equal(processes.length, 0);
  ready = true;
  const retry = (controller as unknown as { onGitReady(): Promise<void> }).onGitReady();
  await waitForProcess(1);
  processes[0].succeed(blameOutput('Ready', '1111111111111111111111111111111111111111'));
  await retry;

  assert.deepEqual(authors(editor), ['Ready']);
  controller.dispose();
});

after(() => {
  loader._load = originalLoad;
});

test('blame hover trusts only reveal-commit when metadata contains command links', async () => {
  const { BlameController } = await controllerModule;
  const controller = new BlameController({
    getGitPath: () => 'git',
    resolveRepoRoot: () => undefined,
  });
  let hover: MarkdownString | undefined;
  const editor = {
    document: { lineCount: 1 },
    setDecorations: (_type: unknown, options: Array<{ hoverMessage: MarkdownString }>) => {
      if (options[0]) hover = options[0].hoverMessage;
    },
  };
  const lines: BlameLine[] = [{
    finalLine: 1,
    commit: {
      sha: '1234567890abcdef',
      author: '[run](command:workbench.action.closeWindow)',
      authorTime: 1,
      summary: '[also run](command:evil.command)',
      isUncommitted: false,
    },
  }];

  (controller as unknown as {
    applyDecorations(editor: unknown, lines: BlameLine[]): void;
  }).applyDecorations(editor, lines);

  assert.match(hover?.value ?? '', /command:workbench\.action\.closeWindow/);
  assert.match(hover?.value ?? '', /command:evil\.command/);
  assert.deepEqual(hover?.isTrusted, { enabledCommands: ['clipcode.blame.revealCommit'] });
  controller.dispose();
});

test('newer blame render wins when an older request completes last', async () => {
  const { BlameController } = await controllerModule;
  const editor = makeEditor();
  vscode.window.activeTextEditor = editor;
  vscode.window.visibleTextEditors = [editor];
  const controller = new BlameController({
    getGitPath: () => 'git',
    resolveRepoRoot: () => ({ repoRoot: '/repo', head: 'HEAD' }),
  });

  const firstRender = controller.toggle();
  await waitForProcess(1);
  const secondRender = controller.onActiveEditor(editor as never);
  await waitForProcess(2);

  processes[1].succeed(blameOutput('New', '2222222222222222222222222222222222222222'));
  await secondRender;
  assert.deepEqual(authors(editor), ['New']);

  processes[0].succeed(blameOutput('Old', '1111111111111111111111111111111111111111'));
  await firstRender;
  assert.deepEqual(authors(editor), ['New']);
  controller.dispose();
});

test('stale blame failure does not clear a newer successful render', async () => {
  const { BlameController } = await controllerModule;
  const editor = makeEditor();
  vscode.window.activeTextEditor = editor;
  vscode.window.visibleTextEditors = [editor];
  const controller = new BlameController({
    getGitPath: () => 'git',
    resolveRepoRoot: () => ({ repoRoot: '/repo', head: 'HEAD' }),
  });

  const firstRender = controller.toggle();
  await waitForProcess(1);
  const secondRender = controller.onActiveEditor(editor as never);
  await waitForProcess(2);

  processes[1].succeed(blameOutput('New', '2222222222222222222222222222222222222222'));
  await secondRender;
  assert.deepEqual(authors(editor), ['New']);

  processes[0].fail();
  await firstRender;
  assert.deepEqual(authors(editor), ['New']);
  controller.dispose();
});

test('closing and reopening the same editor identity resets blame state and cache', async () => {
  const { BlameController } = await controllerModule;
  const firstEditor = makeEditor();
  vscode.window.activeTextEditor = firstEditor;
  vscode.window.visibleTextEditors = [firstEditor];
  const controller = new BlameController({
    getGitPath: () => 'git',
    resolveRepoRoot: () => ({ repoRoot: '/repo', head: 'HEAD' }),
  });

  const firstRender = controller.toggle();
  await waitForProcess(1);
  processes[0].succeed(blameOutput('Old', '1111111111111111111111111111111111111111'));
  await firstRender;

  (controller as unknown as { onCloseDocument(doc: TestDocument): void })
    .onCloseDocument(firstEditor.document);

  const reopenedEditor = makeEditor(makeDocument(), 1);
  vscode.window.activeTextEditor = reopenedEditor;
  vscode.window.visibleTextEditors = [reopenedEditor];
  await controller.onActiveEditor(reopenedEditor as never);
  assert.equal(processes.length, 1);
  assert.deepEqual(labels(reopenedEditor), []);

  const reopenedRender = controller.toggle();
  await waitForProcess(2);
  processes[1].succeed(blameOutput('New', '2222222222222222222222222222222222222222'));
  await reopenedRender;
  assert.deepEqual(authors(reopenedEditor), ['New']);
  controller.dispose();
});

test('closing one split resets its editor state while the document remains visible elsewhere', async () => {
  const { BlameController } = await controllerModule;
  const document = makeDocument();
  const left = makeEditor(document, 1);
  const right = makeEditor(document, 2);
  vscode.window.activeTextEditor = left;
  vscode.window.visibleTextEditors = [left, right];
  const controller = new BlameController({
    getGitPath: () => 'git',
    resolveRepoRoot: () => ({ repoRoot: '/repo', head: 'HEAD' }),
  });

  const enable = controller.toggle();
  await waitForProcess(1);
  processes[0].succeed(blameOutput('Old', '1111111111111111111111111111111111111111'));
  await enable;

  vscode.window.visibleTextEditors = [right];
  (controller as unknown as { onVisibleEditors(editors: TestEditor[]): void })
    .onVisibleEditors([right]);

  const reopened = makeEditor(document, 1);
  vscode.window.activeTextEditor = reopened;
  vscode.window.visibleTextEditors = [reopened, right];
  (controller as unknown as { onVisibleEditors(editors: TestEditor[]): void })
    .onVisibleEditors([reopened, right]);
  await controller.onActiveEditor(reopened as never);
  assert.equal(processes.length, 1);
  assert.deepEqual(labels(reopened), []);

  const reopenedRender = controller.toggle();
  await waitForProcess(2);
  processes[1].succeed(blameOutput('New', '2222222222222222222222222222222222222222'));
  await reopenedRender;
  assert.deepEqual(authors(reopened), ['New']);
  controller.dispose();
});

test('git HEAD change rerenders an enabled visible editor without a text change', async () => {
  const { BlameController } = await controllerModule;
  const editor = makeEditor();
  vscode.window.activeTextEditor = editor;
  vscode.window.visibleTextEditors = [editor];
  let head = 'old-head';
  const controller = new BlameController({
    getGitPath: () => 'git',
    resolveRepoRoot: () => ({ repoRoot: '/repo', head }),
  });

  const firstRender = controller.toggle();
  await waitForProcess(1);
  processes[0].succeed(blameOutput('Old', '1111111111111111111111111111111111111111'));
  await firstRender;

  head = 'new-head';
  const rerender = (controller as unknown as {
    onRepoChange(repoRoot: { fsPath: string }): Promise<void>;
  }).onRepoChange({ fsPath: '/repo' });
  await waitForProcess(2);
  processes[1].succeed(blameOutput('New', '2222222222222222222222222222222222222222'));
  await rerender;

  assert.deepEqual(authors(editor), ['New']);
  controller.dispose();
});

test('document change rerenders every enabled visible split pane', async () => {
  const { BlameController } = await controllerModule;
  const document = makeDocument();
  const left = makeEditor(document, 1);
  const right = makeEditor(document, 2);
  vscode.window.visibleTextEditors = [left, right];
  vscode.window.activeTextEditor = left;
  const controller = new BlameController({
    getGitPath: () => 'git',
    resolveRepoRoot: () => ({ repoRoot: '/repo', head: 'HEAD' }),
  });

  const leftEnable = controller.toggle();
  await waitForProcess(1);
  processes[0].succeed(blameOutput('Old', '1111111111111111111111111111111111111111'));
  await leftEnable;

  vscode.window.activeTextEditor = right;
  await controller.toggle();
  assert.deepEqual(authors(right), ['Old']);

  document.version++;
  vscode.window.activeTextEditor = left;
  await controller.onDocChange(document as never);
  await new Promise(resolve => setTimeout(resolve, 350));
  await waitForProcess(2);
  processes[1].succeed(blameOutput('New', '2222222222222222222222222222222222222222'));
  await new Promise<void>(resolve => setImmediate(resolve));

  assert.deepEqual(authors(left), ['New']);
  assert.deepEqual(authors(right), ['New']);
  controller.dispose();
});

test('enabled blame stops rendering after the document grows past the line cap', async () => {
  const { BlameController } = await controllerModule;
  const document = makeDocument();
  const editor = makeEditor(document);
  vscode.window.activeTextEditor = editor;
  vscode.window.visibleTextEditors = [editor];
  const controller = new BlameController({
    getGitPath: () => 'git',
    resolveRepoRoot: () => ({ repoRoot: '/repo', head: 'HEAD' }),
  });

  const enable = controller.toggle();
  await waitForProcess(1);
  processes[0].succeed(blameOutput('Old', '1111111111111111111111111111111111111111'));
  await enable;

  document.lineCount = 20_001;
  document.version++;
  const rerender = controller.onActiveEditor(editor as never);
  await new Promise<void>(resolve => setImmediate(resolve));
  const processCount = processes.length;
  if (processes[1]) processes[1].fail();
  await rerender;

  assert.equal(processCount, 1);
  assert.deepEqual(labels(editor), []);
  controller.dispose();
});

test('new debounced blame render cancels the previous in-flight process', async () => {
  const { BlameController } = await controllerModule;
  const document = makeDocument();
  const editor = makeEditor(document);
  vscode.window.activeTextEditor = editor;
  vscode.window.visibleTextEditors = [editor];
  const controller = new BlameController({
    getGitPath: () => 'git',
    resolveRepoRoot: () => ({ repoRoot: '/repo', head: 'HEAD' }),
  });

  const enable = controller.toggle();
  await waitForProcess(1);
  processes[0].succeed(blameOutput('Initial', '1111111111111111111111111111111111111111'));
  await enable;

  document.version++;
  await controller.onDocChange(document as never);
  await new Promise(resolve => setTimeout(resolve, 350));
  await waitForProcess(2);

  document.version++;
  await controller.onDocChange(document as never);
  await new Promise(resolve => setTimeout(resolve, 350));
  await waitForProcess(3);

  const previousWasKilled = processes[1].killed;
  processes[1].fail();
  processes[2].succeed(blameOutput('Latest', '3333333333333333333333333333333333333333'));
  await new Promise<void>(resolve => setImmediate(resolve));

  assert.equal(previousWasKilled, true);
  controller.dispose();
});
