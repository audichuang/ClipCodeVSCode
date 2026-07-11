import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [svelte()],
  build: {
    outDir: 'dist',
    rollupOptions: {
      // Two pages → two entries. Each html pulls its own /src/*.ts entry.
      input: {
        main: resolve(__dirname, 'index.html'),
        workbench: resolve(__dirname, 'workbench.html'),
      },
      output: {
        // Deterministic, unhashed names so MainPanel.getHtmlForWebview and
        // CommitWorkbenchViewProvider.getHtml can hardcode main.*/workbench.*.
        entryFileNames: '[name].js',
        chunkFileNames: '[name].js',
        assetFileNames: '[name][extname]',
        manualChunks: undefined,
      },
    },
    // Per-entry CSS (main.css / workbench.css). Was false for the single-entry
    // build; MUST be true now or both entries share one merged stylesheet.
    cssCodeSplit: true,
    assetsInlineLimit: 100000,
    chunkSizeWarningLimit: 800,
  },
});
