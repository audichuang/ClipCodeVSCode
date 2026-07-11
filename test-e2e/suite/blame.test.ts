import * as assert from 'node:assert';

import * as vscode from 'vscode';

describe('blame smoke', () => {
  before(async () => {
    const ext = vscode.extensions.getExtension('audichuang.clipcode-vscode');
    assert.ok(ext, 'extension present');
    await ext!.activate();
  });

  it('toggle command is registered and does not throw with no editor', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('clipcode.blame.toggle'));
    // With no active text editor, toggle should no-op silently.
    await vscode.commands.executeCommand('clipcode.blame.toggle');
  });
});
