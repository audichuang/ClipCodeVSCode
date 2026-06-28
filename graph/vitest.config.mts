import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  test: {
    // JUnit output drives Codecov Test Analytics (flaky detection, slow-test
    // ranking, failure history). `default` keeps the local console output.
    reporters: ['default', ['junit', { outputFile: 'test-results.xml' }]],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'json-summary'],
      include: ['src/**/*.ts', 'webview-ui/src/**/*.{ts,svelte}'],
      exclude: [
        '**/__tests__/**',
        '**/*.test.ts',
        'src/**/types.ts',
        // vscode-bound modules — covered by manual testing of the extension,
        // not unit/integration. Excluded so the % reflects testable code.
        // file-watcher.ts, git-content-provider.ts and the views/ tree
        // providers were brought under test with a vscode mock and are counted.
        // extension.ts and panels/MainPanel.ts now have representative smoke /
        // routing tests too (see their __tests__), but stay excluded from the
        // % : exhaustively covering the activation wiring and ~80 message cases
        // is low-value boilerplate, and counting them would make the metric
        // reflect host plumbing rather than testable logic.
        'src/extension.ts',
        'src/panels/**',
        // Only message-bus.ts is type-only; the other utils (buffer-stream,
        // sequence-guard, path-validation) have real logic + tests, so keep
        // them in the coverage report.
        'src/utils/message-bus.ts',
        'src/git/vscode-git-bridge.ts',
        // Webview entry + canvas-bound rendering + shiki-bound highlighter
        // are exercised manually in the running extension; not worth shimming
        // for unit tests.
        'webview-ui/src/main.ts',
        'webview-ui/src/vite-env.d.ts',
        'webview-ui/src/components/graph/**',
        'webview-ui/src/lib/utils/highlighter.ts',
      ],
    },
    projects: [
      {
        // Backend: extension host code, runs against the real `git` CLI in
        // a node environment with no DOM shims.
        extends: true,
        test: {
          name: 'backend',
          include: ['src/**/*.test.ts'],
          environment: 'node',
          // Integration tests spawn real git/git-flow/git-lfs processes and
          // can exceed the default 5s budget on slower runners (CI). Raise
          // both the test timeout and the per-hook timeout for setup/cleanup.
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
      {
        // Webview: Svelte 5 components and rune-based stores. happy-dom
        // gives us DOM + window + microtask scheduling that Svelte's
        // reactivity expects without paying jsdom's startup cost.
        extends: true,
        plugins: [svelte({ hot: false })],
        resolve: {
          conditions: ['browser'],
        },
        test: {
          name: 'webview',
          include: ['webview-ui/src/**/*.test.ts'],
          // The shared setup file does not match the include glob (no
          // `.test.ts` suffix), but we still need it loaded before each
          // test file — that's what setupFiles is for.
          setupFiles: ['webview-ui/src/__tests__/setup.ts'],
          environment: 'happy-dom',
          // @testing-library/svelte ships rune-using helpers in `.svelte.js`
          // files inside node_modules; vite externalises those by default,
          // which strips them of svelte preprocessing. Inline so the svelte
          // plugin compiles them and `$state` resolves at runtime.
          server: { deps: { inline: [/@testing-library\/svelte/] } },
        },
      },
    ],
  },
});
