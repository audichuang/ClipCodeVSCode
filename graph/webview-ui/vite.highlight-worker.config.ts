import { defineConfig } from 'vite';
import { resolve } from 'node:path';

// VS Code blob workers cannot import chunks; inline grammars and WASM into one script.
export default defineConfig({
  build: {
    outDir: 'dist', emptyOutDir: false,
    lib: { entry: resolve(__dirname, 'src/highlight-worker.ts'), formats: ['iife'], name: 'SnipcodeHighlightWorker', fileName: () => 'highlight-worker.js' },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
