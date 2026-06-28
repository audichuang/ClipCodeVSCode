import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { requestDirtyState } from '../dirty-check';

// Helper: dispatch the `dirtyState` reply the extension would post back.
function reply(requestId: string, dirty: unknown) {
  window.dispatchEvent(
    new MessageEvent('message', { data: { type: 'dirtyState', payload: { requestId, dirty } } }),
  );
}

// The most recently sent checkDirty request id, read from the recording stub.
function lastRequestId(): string {
  const posted = globalThis.__postedMessages.at(-1)?.data as {
    type: string;
    payload: { requestId: string };
  };
  expect(posted.type).toBe('checkDirty');
  return posted.payload.requestId;
}

describe('requestDirtyState', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves with the dirty flag from the matching reply', async () => {
    const promise = requestDirtyState();
    reply(lastRequestId(), true);
    await expect(promise).resolves.toBe(true);
  });

  it('coerces a truthy/falsy payload to a strict boolean', async () => {
    const promise = requestDirtyState();
    reply(lastRequestId(), 0);
    await expect(promise).resolves.toBe(false);
  });

  it('ignores replies whose requestId does not match', async () => {
    const promise = requestDirtyState();
    const id = lastRequestId();
    reply('some-other-id', true); // wrong id — must be ignored
    reply(id, false); // the real one
    await expect(promise).resolves.toBe(false);
  });

  it('ignores messages of an unrelated type', async () => {
    const promise = requestDirtyState();
    const id = lastRequestId();
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'somethingElse' } }));
    reply(id, true);
    await expect(promise).resolves.toBe(true);
  });

  it('rejects after the request times out', async () => {
    const promise = requestDirtyState();
    const assertion = expect(promise).rejects.toThrow(/timed out/);
    vi.advanceTimersByTime(30_000);
    await assertion;
  });

  it('ignores a late reply that arrives after the timeout', async () => {
    const promise = requestDirtyState();
    const id = lastRequestId();
    const assertion = expect(promise).rejects.toThrow(/timed out/);
    vi.advanceTimersByTime(30_000);
    await assertion;
    // A reply arriving after the timeout must not throw or double-settle.
    expect(() => reply(id, true)).not.toThrow();
  });

  it('uses a unique requestId per call so concurrent requests do not collide', async () => {
    const first = requestDirtyState();
    const firstId = lastRequestId();
    const second = requestDirtyState();
    const secondId = lastRequestId();
    expect(firstId).not.toBe(secondId);

    reply(secondId, true);
    reply(firstId, false);
    await expect(first).resolves.toBe(false);
    await expect(second).resolves.toBe(true);
  });
});
