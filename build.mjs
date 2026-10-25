/**
 * build.mjs: bundles src/main.js into dist/app.js with esbuild (ESM, es2022)
 * and copies the static shell (src/index.html, src/styles.css) into dist/.
 *
 *   node build.mjs           production build (minified, linked source map)
 *   node build.mjs --dev     unminified build with inline source maps
 *   node build.mjs --watch   dev build that rebuilds on every change
 */
import * as esbuild from 'esbuild';
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import { watch } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.join(root, 'src');
const distDir = path.join(root, 'dist');
const args = new Set(process.argv.slice(2));
const watchMode = args.has('--watch');
const dev = watchMode || args.has('--dev');
const STATIC_FILES = ['index.html', 'styles.css'];

const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const buildInfo = { version: pkg.version, mode: dev ? 'development' : 'production', builtAt: new Date().toISOString() };

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: [path.join(srcDir, 'main.js')],
  outfile: path.join(distDir, 'app.js'),
  bundle: true,
  format: 'esm',
  target: 'es2022',
  platform: 'browser',
  minify: !dev,
  sourcemap: dev ? 'inline' : 'linked',
  legalComments: 'eof', // keeps the three.js MIT licence notice in the bundle
  define: { __PETSTUDIO_BUILD__: JSON.stringify(buildInfo) },
  metafile: true,
  logLevel: 'warning',
};

async function copyStatic() {
  await Promise.all(STATIC_FILES.map((f) => copyFile(path.join(srcDir, f), path.join(distDir, f))));
}

function report(result, startedAt) {
  const outputs = Object.entries(result.metafile?.outputs ?? {})
    .filter(([file]) => file.endsWith('.js'))
    .map(([file, info]) => `${path.relative(root, file)} ${(info.bytes / 1024).toFixed(1)} KiB`);
  const warnings = result.warnings?.length ?? 0;
  console.log(`[build] ${buildInfo.mode}: ${outputs.join(', ')} + ${STATIC_FILES.join(', ')} in ${Date.now() - startedAt} ms` +
    (warnings ? ` (${warnings} warning${warnings > 1 ? 's' : ''})` : ''));
}

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

if (watchMode) {
  const ctx = await esbuild.context({
    ...options,
    plugins: [{
      name: 'report',
      setup(build) {
        let started = Date.now();
        build.onStart(() => { started = Date.now(); });
        build.onEnd(async (result) => {
          if (!result.errors.length) {
            await copyStatic();
            report(result, started);
          }
        });
      },
    }],
  });
  await ctx.watch();
  for (const f of STATIC_FILES) {
    watch(path.join(srcDir, f), () => copyStatic().then(() => console.log(`[build] copied ${f}`)).catch(console.error));
  }
  console.log('[build] watching src/ for changes (Ctrl+C to stop)');
} else {
  const started = Date.now();
  try {
    const result = await esbuild.build(options);
    await copyStatic();
    report(result, started);
  } catch (err) {
    // esbuild has already printed the diagnostics.
    console.error('[build] failed');
    process.exit(1);
  }
}
