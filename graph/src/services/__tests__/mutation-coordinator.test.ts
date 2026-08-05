import { describe, it, expect } from 'vitest';
import { runExclusive } from '../mutation-coordinator';

const tick = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

describe('runExclusive', () => {
  it('serializes calls on the same repo path (no interleaving)', async () => {
    const events: string[] = [];
    const first = runExclusive('/repo-a', async () => {
      events.push('1-enter');
      await tick(20);
      events.push('1-exit');
    });
    const second = runExclusive('/repo-a', async () => {
      events.push('2-enter');
      events.push('2-exit');
    });
    await Promise.all([first, second]);
    expect(events).toEqual(['1-enter', '1-exit', '2-enter', '2-exit']);
  });

  it('runs different repo paths concurrently', async () => {
    const events: string[] = [];
    let releaseA!: () => void;
    const aBlocked = new Promise<void>(r => { releaseA = r; });

    const pa = runExclusive('/repo-a', async () => {
      events.push('a-enter');
      await aBlocked; // stay inside until B has entered
      events.push('a-exit');
    });
    const pb = runExclusive('/repo-b', async () => {
      events.push('b-enter');
      releaseA(); // B entered while A was still blocked -> proves parallelism
    });

    await Promise.all([pa, pb]);
    expect(events).toEqual(['a-enter', 'b-enter', 'a-exit']);
  });

  it('a rejecting call does not break the chain for the next call', async () => {
    const boom = runExclusive('/repo-c', async () => { throw new Error('boom'); });
    await expect(boom).rejects.toThrow('boom');
    const after = await runExclusive('/repo-c', async () => 'ok');
    expect(after).toBe('ok');
  });
});
