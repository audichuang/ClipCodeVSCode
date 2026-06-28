import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import { GitService } from '../git-service';

// predictConflicts / predictRebaseConflicts drive `git merge-tree` through a
// raw spawn (mergeTreeCheck). The happy paths run against real git in the
// integration suite; here we mock spawn to exercise the fallbacks that real
// git on the CI box won't reproduce: old git (<2.40) rejecting --merge-base,
// transient errors, and empty replay ranges.
import * as childProcess from 'child_process';
vi.mock('child_process', () => ({ spawn: vi.fn() }));

interface SpawnResponse { stdout?: string; stderr?: string; code: number; }

function fakeProc() {
  const proc = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  return proc;
}

const spawnMock = vi.mocked(childProcess.spawn);
// Per-spawn scripted responses, consumed in call order.
let responses: SpawnResponse[] = [];
let spawnArgs: string[][] = [];

beforeEach(() => {
  responses = [];
  spawnArgs = [];
  spawnMock.mockImplementation((_bin: string, args: readonly string[]) => {
    spawnArgs.push([...args]);
    const proc = fakeProc();
    const resp = responses.shift() ?? { code: 0 };
    // Emit asynchronously, the way a real child would, after the caller has
    // attached its data/end/close listeners. mergeTreeCheck now reads the
    // streams via exec()'s bufferStream, which resolves on 'end' — so each
    // stream must end before 'close', or exec waits forever.
    queueMicrotask(() => {
      if (resp.stdout) proc.stdout.emit('data', Buffer.from(resp.stdout));
      proc.stdout.emit('end');
      if (resp.stderr) proc.stderr.emit('data', Buffer.from(resp.stderr));
      proc.stderr.emit('end');
      proc.emit('close', resp.code);
    });
    return proc as unknown as ReturnType<typeof childProcess.spawn>;
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('predictConflicts fallbacks', () => {
  it('falls back to the no-merge-base form when git rejects --merge-base (old git)', async () => {
    const service = new GitService('/tmp/repo');
    responses = [
      // First call carries --merge-base and is rejected by old git.
      { stderr: 'error: unknown option `merge-base=...`', code: 129 },
      // Fallback call (no --merge-base) succeeds with no conflict.
      { code: 0 },
    ];
    const result = await service.predictConflicts('ours', 'theirs', 'base');
    expect(result).toEqual({ hasConflict: false, files: [] });
    // Two spawns: the rejected --merge-base attempt, then the fallback.
    expect(spawnArgs).toHaveLength(2);
    expect(spawnArgs[0].join(' ')).toContain('--merge-base=base');
    expect(spawnArgs[1].join(' ')).not.toContain('--merge-base');
  });

  it('reports conflicting files from the structured file-info section, deduped across stages', async () => {
    const service = new GitService('/tmp/repo');
    // Real `merge-tree --write-tree` output: tree OID, then one
    // "<mode> <oid> <stage>\t<path>" line per conflicted index entry (each
    // file shows up at stages 1/2/3), a blank line, then the prose messages.
    const treeOid = 'a'.repeat(40);
    const oid = (n: number) => n.toString(16).padStart(40, '0');
    responses = [{
      code: 1,
      stdout:
        `${treeOid}\n` +
        `100644 ${oid(1)} 1\tsrc/a.ts\n` +
        `100644 ${oid(2)} 2\tsrc/a.ts\n` +
        `100644 ${oid(3)} 3\tsrc/a.ts\n` +
        `100644 ${oid(4)} 1\tsrc/b.ts\n` +
        `100644 ${oid(5)} 2\tsrc/b.ts\n` +
        `100644 ${oid(6)} 3\tsrc/b.ts\n` +
        `\n` +
        `Auto-merging src/a.ts\n` +
        `CONFLICT (content): Merge conflict in src/a.ts\n` +
        `Auto-merging src/b.ts\n` +
        `CONFLICT (content): Merge conflict in src/b.ts\n`,
    }];
    const result = await service.predictConflicts('ours', 'theirs', 'base');
    expect(result.hasConflict).toBe(true);
    expect(result.files).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('parses the path for a modify/delete conflict (not the commit hash in the prose)', async () => {
    const service = new GitService('/tmp/repo');
    // The prose line embeds " in <hash>" multiple times; the old regex grabbed
    // the hash. The file-info section carries the real path.
    const treeOid = 'b'.repeat(40);
    responses = [{
      code: 1,
      stdout:
        `${treeOid}\n` +
        `100644 ${'1'.repeat(40)} 1\tg.txt\n` +
        `100644 ${'3'.repeat(40)} 3\tg.txt\n` +
        `\n` +
        `CONFLICT (modify/delete): g.txt deleted in ${'c'.repeat(40)} and modified in ${'d'.repeat(40)}. Version ${'d'.repeat(40)} of g.txt left in tree.\n`,
    }];
    const result = await service.predictConflicts('ours', 'theirs', 'base');
    expect(result.hasConflict).toBe(true);
    expect(result.files).toEqual(['g.txt']);
  });

  it('surfaces a conflict even when no file-info entries are present', async () => {
    const service = new GitService('/tmp/repo');
    responses = [{
      code: 1,
      stdout: `${'e'.repeat(40)}\n\nCONFLICT (rename/rename): foo renamed to bar and baz\n`,
    }];
    const result = await service.predictConflicts('ours', 'theirs', 'base');
    expect(result.hasConflict).toBe(true);
    expect(result.files).toEqual([]);
  });

  it('returns no-conflict when both the primary and fallback checks error out', async () => {
    const service = new GitService('/tmp/repo');
    responses = [
      // Primary (with --merge-base): a real error, not an unknown-option.
      { stderr: 'fatal: not a valid object name', code: 128 },
      // Fallback (no --merge-base): also errors.
      { stderr: 'fatal: not a valid object name', code: 128 },
    ];
    const result = await service.predictConflicts('ours', 'theirs', 'base');
    expect(result).toEqual({ hasConflict: false, files: [] });
    expect(spawnArgs).toHaveLength(2);
  });
});

describe('predictRebaseConflicts fallbacks', () => {
  it('returns no-conflict for an empty replay range (branch fully merged)', async () => {
    const service = new GitService('/tmp/repo');
    // merge-base resolves, the rev-list of commits to replay is empty.
    (service as never as { exec: (a: string[]) => Promise<string> }).exec = vi.fn(async (args: string[]) => {
      if (args[0] === 'merge-base') return 'basehash\n';
      if (args[0] === 'log') return '\n';
      return '';
    });
    const result = await service.predictRebaseConflicts('branch', 'onto');
    expect(result).toEqual({ hasConflict: false, files: [] });
    // No merge-tree spawn needed when there's nothing to replay.
    expect(spawnArgs).toHaveLength(0);
  });

  it('falls back to a single merge-tree check when no merge base exists', async () => {
    const service = new GitService('/tmp/repo');
    // mergeTreeCheck now runs through exec too, so drive everything via the exec
    // mock: no merge base, and a single clean merge-tree probe.
    const execMock = vi.fn(async (args: string[]) => {
      if (args[0] === 'merge-base') throw new Error('no merge base');
      return ''; // merge-tree: clean (exit 0, no conflict output)
    });
    (service as never as { exec: (a: string[]) => Promise<string> }).exec = execMock;
    const result = await service.predictRebaseConflicts('branch', 'onto');
    expect(result).toEqual({ hasConflict: false, files: [] });
    const mergeTreeCalls = execMock.mock.calls.filter(c => (c[0] as string[])[0] === 'merge-tree');
    expect(mergeTreeCalls).toHaveLength(1);
  });
});
