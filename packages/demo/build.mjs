// Bundles the demo runtime (src/index.ts) into a single dependency-free IIFE: dist/demo-backend.js
import { build } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
await build({
  entryPoints: [path.join(dir, 'src/index.ts')],
  outfile: path.join(dir, 'dist/demo-backend.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2020'],
  minify: process.env.DEMO_MINIFY !== '0',
  sourcemap: false,
  legalComments: 'none',
  banner: { js: '/* JETPOOL static demo runtime — replays recorded API fixtures in the browser. */' },
  logLevel: 'info',
});
