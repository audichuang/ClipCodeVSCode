import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'node:path';

// Separate, self-contained build for the Commit Workbench webview
// (workbench.html → src/workbench.ts). Kept apart from the graph build so the
// two never share a chunk: CommitWorkbenchViewProvider loads workbench.js as a
// CLASSIC <script> (nonce CSP, no type="module"), so a top-level `import` from a
// shared chunk would break boot. `inlineDynamicImports` forces ONE self-contained
// workbench.js. Runs AFTER the graph build with emptyOutDir:false so it adds to
// (never wipes) the graph's dist output.
export default defineConfig({
  plugins: [svelte()],
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    rollupOptions: {
      input: resolve(__dirname, 'workbench.html'),
      output: {
        entryFileNames: 'workbench.js',
        assetFileNames: 'workbench.css',
        inlineDynamicImports: true,
      },
    },
    assetsInlineLimit: 100000,
    cssCodeSplit: false,
    chunkSizeWarningLimit: 800,
  },
});
