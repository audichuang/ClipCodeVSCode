import assert from 'node:assert/strict';
import Module from 'node:module';
import test from 'node:test';
import type { BlameLine } from '../src/blame/blameParser.js';

test('blame hover trusts only reveal-commit when metadata contains command links', async () => {
  class MarkdownString {
    isTrusted: boolean | { enabledCommands: readonly string[] } | undefined;
    value = '';
    appendMarkdown(markdown: string): this { this.value += markdown; return this; }
  }
  class ThemeColor { constructor(readonly id: string) {} }
  class Range { constructor(..._args: number[]) {} }
  const vscode = {
    MarkdownString,
    ThemeColor,
    Range,
    window: {
      createTextEditorDecorationType: () => ({ dispose() {} }),
    },
  };
  const loader = Module as unknown as {
    _load(request: string, parent: unknown, isMain: boolean): unknown;
  };
  const originalLoad = loader._load;
  loader._load = function (request, parent, isMain) {
    return request === 'vscode' ? vscode : originalLoad.call(this, request, parent, isMain);
  };

  try {
    const { BlameController } = await import('../src/blame/blameController.js');
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
  } finally {
    loader._load = originalLoad;
  }
});
