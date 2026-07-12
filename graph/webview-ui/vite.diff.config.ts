import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'node:path';

// Separate, self-contained build for the Diff webview (diff.html → src/diff.ts).
// Kept apart from the graph (vite.config.ts) and commit-box (vite.workbench.config.ts)
// builds so the three never share a chunk: SnipcodeDiffViewProvider loads diff.js
// as a CLASSIC <script> (nonce CSP, no type="module"), so a top-level `import`
// from a shared chunk would break boot. `inlineDynamicImports` forces ONE
// self-contained diff.js. Runs with emptyOutDir:false so it ADDS to (never wipes)
// the graph + workbench dist output.
export default defineConfig({
  plugins: [svelte()],
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    rollupOptions: {
      input: resolve(__dirname, 'diff.html'),
      output: {
        entryFileNames: 'diff.js',
        assetFileNames: 'diff.css',
        inlineDynamicImports: true,
      },
    },
    assetsInlineLimit: 100000,
    cssCodeSplit: false,
    chunkSizeWarningLimit: 800,
  },
});
