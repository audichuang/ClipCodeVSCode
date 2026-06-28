import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { GitService, GitError } from '../git-service';

// Mock child_process so we can drive the spawned process by hand: emit stdout
// to trigger the buffer-overflow guard, or withhold 'close' to trigger the
// timeout guard. These two paths in GitService.exec are the safety net that
// keeps a pathological git invocation from OOMing or hanging the extension
// host, so they're worth exercising even though they can't run real git.
import * as childProcess from 'child_process';
vi.mock('child_process', () => ({ spawn: vi.fn() }));

// Minimal stream stand-in. bufferStream only uses on('data'|'end'|'error') and
// destroy(), so a plain EventEmitter avoids the real Readable's internal
// setImmediate scheduling (which deadlocks against fake timers).
function fakeStream() {
  const s = new EventEmitter() as EventEmitter & { destroy: ReturnType<typeof vi.fn> };
  s.destroy = vi.fn();
  return s;
}

function fakeProc() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: ReturnType<typeof fakeStream>;
    stderr: ReturnType<typeof fakeStream>;
    stdin: { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdout = fakeStream();
  proc.stderr = fakeStream();
  proc.stdin = { write: vi.fn(), end: vi.fn() };
  proc.kill = vi.fn();
  return proc;
}

const spawnMock = vi.mocked(childProcess.spawn);

describe('GitService.exec safety guards', () => {
  let service: GitService;
  let proc: ReturnType<typeof fakeProc>;

  beforeEach(() => {
    vi.useFakeTimers();
    service = new GitService('/tmp/test-repo');
    proc = fakeProc();
    spawnMock.mockReturnValue(proc as unknown as ReturnType<typeof childProcess.spawn>);
  });

  afterEach(() => {
    // Discards killHard()'s pending 5s SIGKILL timer so it can't leak.
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('rejects with a GitError when stdout exceeds maxBufferBytes', async () => {
    const p = (service as never as { exec: (a: string[], o?: object) => Promise<string> })
      .exec(['version'], { maxBufferBytes: 4, silent: true });
    // 11 bytes against a 4-byte cap → overflow.
    proc.stdout.emit('data', Buffer.from('hello world'));
    await expect(p).rejects.toThrow(/exceeded 4 bytes/);
    await expect(p).rejects.toBeInstanceOf(GitError);
    // The guard must terminate the runaway process.
    expect(proc.kill).toHaveBeenCalled();
  });

  it('rejects with a GitError when the command exceeds its timeout', async () => {
    const p = (service as never as { exec: (a: string[], o?: object) => Promise<string> })
      .exec(['version'], { timeout: 20, silent: true });
    // Attach the rejection handler before advancing time, so the timeout
    // reject never momentarily looks "unhandled" between fire and assert.
    const assertion = expect(p).rejects.toThrow(/timed out after 20ms/);
    // Never emit 'close'; let the timeout timer fire.
    await vi.advanceTimersByTimeAsync(20);
    await assertion;
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('uses a 60s default timeout when none is given', async () => {
    const p = (service as never as { exec: (a: string[], o?: object) => Promise<string> })
      .exec(['version'], { silent: true });
    const assertion = expect(p).rejects.toThrow(/timed out after 60000ms/);
    // Never emit 'close'; let the default timeout timer fire.
    await vi.advanceTimersByTimeAsync(60000);
    await assertion;
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('honors a default timeout overridden via setDefaultTimeout', async () => {
    service.setDefaultTimeout(120000);
    const p = (service as never as { exec: (a: string[], o?: object) => Promise<string> })
      .exec(['version'], { silent: true });
    const assertion = expect(p).rejects.toThrow(/timed out after 120000ms/);
    await vi.advanceTimersByTimeAsync(120000);
    await assertion;
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('ignores a non-positive default timeout and keeps the 60s fallback', async () => {
    service.setDefaultTimeout(0);
    const p = (service as never as { exec: (a: string[], o?: object) => Promise<string> })
      .exec(['version'], { silent: true });
    const assertion = expect(p).rejects.toThrow(/timed out after 60000ms/);
    await vi.advanceTimersByTimeAsync(60000);
    await assertion;
  });

  it('resolves with stdout on a clean exit (control case)', async () => {
    const p = (service as never as { exec: (a: string[], o?: object) => Promise<string> })
      .exec(['version'], { silent: true });
    proc.stdout.emit('data', Buffer.from('git version 2.40.0'));
    proc.stdout.emit('end');
    proc.stderr.emit('end');
    proc.emit('close', 0);
    await expect(p).resolves.toBe('git version 2.40.0');
  });
});
