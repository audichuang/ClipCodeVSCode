import * as esbuild from 'esbuild';

// Host extension bundle. The single VSIX entry (package.json main =
// ./dist/extension.js). src/extension.ts pulls in the vendored graph host code
// (graph/src/extension.ts via activateGraph), so esbuild bundles both trees and
// all host runtime deps into one CJS file — node_modules is NOT shipped.
const ctx = await esbuild.context({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  sourcemap: true,
  target: 'node18',
});

if (process.argv.includes('--watch')) {
  console.log('Watching for changes...');
  await ctx.watch();
} else {
  await ctx.rebuild();
  await ctx.dispose();
}
