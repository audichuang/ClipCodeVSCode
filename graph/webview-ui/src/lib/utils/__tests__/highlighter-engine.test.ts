import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Engine startup can only fail now that it compiles WebAssembly: a host CSP
// without 'wasm-unsafe-eval' refuses compilation outright. A rejection cached
// in the module's `loadingPromise` would hand the same failure to every later
// caller, disabling syntax highlighting for the life of the webview even when
// the cause was transient — so the rejection must clear it and let the next
// file open retry.
let attempts = 0;
let failWith: (() => Error) | null = null;
vi.mock('shiki/engine/oniguruma', () => ({
  createOnigurumaEngine: async () => {
    attempts += 1;
    if (failWith && attempts === 1) throw failWith();
    return {} as never;
  },
}));
vi.mock('shiki', () => ({
  createHighlighterCore: async () => ({ getLoadedLanguages: () => [] }),
}));

describe('getHighlighter engine startup', () => {
  beforeEach(async () => { attempts = 0; failWith = null; vi.resetModules(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('retries a TRANSIENT failure instead of caching the rejection forever', async () => {
    failWith = () => new Error('engine init hiccup');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { getHighlighter } = await import('../highlighter');

    await expect(getHighlighter()).rejects.toThrow(/hiccup/);
    expect(warn).toHaveBeenCalledTimes(1); // one breadcrumb, so the failure is diagnosable

    // Second call must actually re-run the engine factory, not replay attempt 1.
    await expect(getHighlighter()).resolves.toBeTruthy();
    expect(attempts).toBe(2);
    expect(warn).toHaveBeenCalledTimes(1); // still once — not a per-file log spam
  });

  // A host CSP without 'wasm-unsafe-eval' refuses WebAssembly compilation with a
  // real CompileError. No retry can ever help, so retrying would mean one doomed
  // WASM compile on every single diff open for the life of the webview.
  it('never retries a PERMANENT (CompileError) failure', async () => {
    failWith = () => new WebAssembly.CompileError('violates the following Content Security policy directive');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { getHighlighter } = await import('../highlighter');

    await expect(getHighlighter()).rejects.toThrow(WebAssembly.CompileError);
    await expect(getHighlighter()).rejects.toThrow(WebAssembly.CompileError);
    expect(attempts).toBe(1);              // the factory ran once, not twice
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('not retryable');
  });
});
