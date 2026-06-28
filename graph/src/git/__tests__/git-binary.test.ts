import { describe, it, expect, afterEach } from 'vitest';
import { getGitBinaryPath, setGitBinaryPath } from '../git-binary';

describe('git-binary', () => {
  afterEach(() => setGitBinaryPath('git')); // reset shared module state

  it("defaults to 'git'", () => {
    expect(getGitBinaryPath()).toBe('git');
  });

  it('stores an explicit path', () => {
    setGitBinaryPath('/usr/local/bin/git');
    expect(getGitBinaryPath()).toBe('/usr/local/bin/git');
  });

  it('keeps a Windows-style path verbatim', () => {
    setGitBinaryPath('D:/app/msys64/mingw64/bin/git.exe');
    expect(getGitBinaryPath()).toBe('D:/app/msys64/mingw64/bin/git.exe');
  });

  it.each([undefined, null, '', '   '])('resets to "git" for %p', (value) => {
    setGitBinaryPath('/custom/git');
    setGitBinaryPath(value as string | undefined | null);
    expect(getGitBinaryPath()).toBe('git');
  });
});
