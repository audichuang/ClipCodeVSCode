import { cp, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Collect the vendored Svelte webview bundle + its codicon dependency into one
// host-owned asset dir (dist/graph-webview). MainPanel's SNIPCODE-HOOK resolves
// every webview resource (main.js, main.css, codicon.css + font) and the CSP
// localResourceRoots from this single dir — so it is the ONLY thing the VSIX
// must ship for the graph to render (node_modules is excluded by .vscodeignore).
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(repoRoot, 'dist', 'graph-webview');
const viteDist = path.join(repoRoot, 'graph', 'webview-ui', 'dist');
const codiconsDist = path.join(repoRoot, 'graph', 'node_modules', '@vscode', 'codicons', 'dist');

await mkdir(outDir, { recursive: true });

// 1. Svelte bundle (main.js + main.css, plus any inlined assets vite emitted).
if (!existsSync(viteDist)) {
  throw new Error(`graph webview build output missing: ${viteDist} (did vite build run?)`);
}
for (const name of await readdir(viteDist)) {
  await cp(path.join(viteDist, name), path.join(outDir, name), { recursive: true });
}

// 2. Codicons css + woff font. MainPanel links <assetRoot>/codicon.css, so both
//    files must sit at the asset-dir root (the css references ./codicon.ttf).
if (!existsSync(codiconsDist)) {
  throw new Error(`codicons missing: ${codiconsDist} (did graph deps install?)`);
}
for (const name of ['codicon.css', 'codicon.ttf']) {
  await cp(path.join(codiconsDist, name), path.join(outDir, name));
}

console.log(`copied graph webview assets -> ${outDir}`);
