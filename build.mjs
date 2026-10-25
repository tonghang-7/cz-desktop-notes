import * as esbuild from 'esbuild';
import { rm, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const dist = path.join(root, 'dist');
const watch = process.argv.includes('--watch');

const base = {
  bundle: true,
  sourcemap: true,
  logLevel: 'info',
  define: { 'process.env.NODE_ENV': '"production"' },
};

const targets = [
  {
    entryPoints: ['src/main/index.ts'],
    outfile: 'dist/main/index.js',
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    external: ['electron'],
  },
  {
    entryPoints: ['src/preload/index.ts'],
    outfile: 'dist/preload/index.js',
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    external: ['electron'],
  },
  {
    entryPoints: ['src/renderer/notepad.ts'],
    outfile: 'dist/renderer/notepad.js',
    platform: 'browser',
    target: 'chrome126',
    format: 'iife',
  },
  {
    entryPoints: ['src/renderer/manager.ts'],
    outfile: 'dist/renderer/manager.js',
    platform: 'browser',
    target: 'chrome126',
    format: 'iife',
  },
];

const statics = [
  ['src/renderer/notepad.html', 'dist/renderer/notepad.html'],
  ['src/renderer/manager.html', 'dist/renderer/manager.html'],
  ['src/renderer/style.css', 'dist/renderer/style.css'],
];

async function copyStatics() {
  for (const [from, to] of statics) {
    await copyFile(path.join(root, from), path.join(root, to));
  }
}

await rm(dist, { recursive: true, force: true });
for (const sub of ['main', 'preload', 'renderer']) {
  await mkdir(path.join(dist, sub), { recursive: true });
}

if (watch) {
  const contexts = await Promise.all(
    targets.map((t) => esbuild.context({ ...base, ...t }))
  );
  for (const ctx of contexts) await ctx.watch();
  await copyStatics();
  console.log('[build] watching...');
} else {
  await Promise.all(targets.map((t) => esbuild.build({ ...base, ...t })));
  await copyStatics();
  console.log('[build] done');
}
