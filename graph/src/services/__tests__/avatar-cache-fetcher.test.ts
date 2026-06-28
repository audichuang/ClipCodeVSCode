import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// Drive the default https-backed fetcher without touching the network by
// mocking `https.get`. Each test installs its own behaviour via `h.getImpl`,
// which the mock delegates to. Using `new AvatarCache(null)` with no injected
// fetcher exercises the real `defaultFetcher` against this fake transport.
const h = vi.hoisted(() => ({
  getImpl: null as unknown as (url: string, cb: (res: unknown) => void) => unknown,
}));

vi.mock('https', () => ({
  get: (url: string, cb: (res: unknown) => void) => h.getImpl(url, cb),
}));

import { AvatarCache } from '../avatar-cache';

const MAX_AVATAR_BYTES = 256 * 1024;

/** A fake outgoing request: an EventEmitter plus the methods the fetcher calls. */
function fakeReq() {
  const req = new EventEmitter() as EventEmitter & {
    setTimeout: (ms: number, cb: () => void) => void;
    destroy: () => void;
  };
  req.setTimeout = vi.fn();
  req.destroy = vi.fn();
  return req;
}

/** A fake incoming response: an EventEmitter plus statusCode/headers/resume. */
function fakeRes(statusCode: number, headers: Record<string, string> = {}) {
  const res = new EventEmitter() as EventEmitter & {
    statusCode: number;
    headers: Record<string, string>;
    resume: () => void;
  };
  res.statusCode = statusCode;
  res.headers = headers;
  res.resume = vi.fn();
  return res;
}

describe('AvatarCache default https fetcher', () => {
  beforeEach(() => {
    h.getImpl = null as never;
  });

  it('returns a data URI built from the response body and content type', async () => {
    const body = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    h.getImpl = (_url, cb) => {
      const req = fakeReq();
      const res = fakeRes(200, { 'content-type': 'image/jpeg' });
      cb(res);
      queueMicrotask(() => {
        res.emit('data', body);
        res.emit('end');
      });
      return req;
    };

    const uri = await new AvatarCache(null).get('a@b.com', 32);

    expect(uri).toBe(`data:image/jpeg;base64,${body.toString('base64')}`);
  });

  it('defaults to image/png when the response has no content-type header', async () => {
    h.getImpl = (_url, cb) => {
      const req = fakeReq();
      const res = fakeRes(200, {}); // no content-type
      cb(res);
      queueMicrotask(() => {
        res.emit('data', Buffer.from([1]));
        res.emit('end');
      });
      return req;
    };

    const uri = await new AvatarCache(null).get('a@b.com', 32);

    expect(uri).toMatch(/^data:image\/png;base64,/);
  });

  it('returns null and drains the body on a non-200 status', async () => {
    const res = fakeRes(404);
    h.getImpl = (_url, cb) => {
      const req = fakeReq();
      cb(res);
      return req;
    };

    const uri = await new AvatarCache(null).get('a@b.com', 32);

    expect(uri).toBeNull();
    expect(res.resume).toHaveBeenCalled();
  });

  it('returns null and destroys the request when the body exceeds the size cap', async () => {
    const req = fakeReq();
    h.getImpl = (_url, cb) => {
      const res = fakeRes(200, { 'content-type': 'image/png' });
      cb(res);
      queueMicrotask(() => res.emit('data', Buffer.alloc(MAX_AVATAR_BYTES + 1)));
      return req;
    };

    const uri = await new AvatarCache(null).get('a@b.com', 32);

    expect(uri).toBeNull();
    expect(req.destroy).toHaveBeenCalled();
  });

  it('returns null and destroys the request on timeout', async () => {
    const req = fakeReq();
    // Fire the timeout callback instead of ever delivering a body.
    req.setTimeout = (_ms: number, cb: () => void) => {
      queueMicrotask(cb);
    };
    h.getImpl = (_url, cb) => {
      const res = fakeRes(200, { 'content-type': 'image/png' });
      cb(res);
      return req;
    };

    const uri = await new AvatarCache(null).get('a@b.com', 32);

    expect(uri).toBeNull();
    expect(req.destroy).toHaveBeenCalled();
  });

  it('returns null when the request emits an error', async () => {
    h.getImpl = () => {
      const req = fakeReq();
      queueMicrotask(() => req.emit('error', new Error('network down')));
      return req;
    };

    const uri = await new AvatarCache(null).get('a@b.com', 32);

    expect(uri).toBeNull();
  });

  it('returns null when the response stream emits an error', async () => {
    h.getImpl = (_url, cb) => {
      const req = fakeReq();
      const res = fakeRes(200, { 'content-type': 'image/png' });
      cb(res);
      queueMicrotask(() => res.emit('error', new Error('reset')));
      return req;
    };

    const uri = await new AvatarCache(null).get('a@b.com', 32);

    expect(uri).toBeNull();
  });
});
