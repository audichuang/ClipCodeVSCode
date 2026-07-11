import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Graph webview build (index.html → src/main.ts). Single self-contained entry:
// the host loads main.js as a CLASSIC <script> (nonce CSP, NOT type="module"),
// so main.js must carry no top-level `import` — a shared chunk would break boot
// (main.js fails to parse → boot handshake times out). The Commit Workbench has
// its OWN separate build (vite.workbench.config.ts) so the two never share a
// chunk. Do NOT reintroduce a second `input` here (that splits shared code into
// a chunk main.js statically imports, which the classic <script> can't load).
export default defineConfig({
  plugins: [svelte()],
  build: {
    outDir: 'dist',
    rollupOptions: {
      output: {
        entryFileNames: 'main.js',
        assetFileNames: 'main.css',
        manualChunks: undefined,
      },
    },
    assetsInlineLimit: 100000,
    cssCodeSplit: false,
    chunkSizeWarningLimit: 800,
  },
});
