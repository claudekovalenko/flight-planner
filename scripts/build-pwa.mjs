#!/usr/bin/env node
// Builds dist/ for static hosting (GitHub Pages).
//
// index.html is authored as a document fragment so it can also be published as a Claude
// Artifact, where the runtime supplies the document shell. This script supplies the same
// shell for the web: doctype, charset, viewport, the artifact's small reset, and the
// PWA head tags. It also stamps the service worker with a build id.
//
// Usage: node scripts/build-pwa.mjs [--build <id>]
import { readFileSync, writeFileSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const argBuild = process.argv.indexOf('--build');
const build = argBuild > -1 ? process.argv[argBuild + 1] : (() => {
  try { return execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim(); } catch { return 'dev'; }
})();

rmSync(DIST, { recursive: true, force: true });
mkdirSync(join(DIST, 'icons'), { recursive: true });

const body = readFileSync(join(ROOT, 'index.html'), 'utf8');
const title = (body.match(/<title>([^<]*)<\/title>/) || [, 'Turnaround Ledger'])[1];

const head = `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="Decide which trips to say yes to: airfare, hours in the air, nights away, tight turnarounds, and what changes if you flip any event.">
<link rel="manifest" href="manifest.webmanifest">
<meta name="theme-color" content="#f3f5f2" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#1b1f1d" media="(prefers-color-scheme: dark)">
<link rel="icon" href="icons/icon.svg" type="image/svg+xml">
<link rel="icon" href="icons/icon-32.png" sizes="32x32" type="image/png">
<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Turnaround">
<meta name="mobile-web-app-capable" content="yes">
<meta property="og:title" content="${title}">
<meta property="og:type" content="website">
<meta name="build" content="${build}">
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 14px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; background: #fbfbfa; }
  img { max-width: 100%; }
  [hidden] { display: none !important; }
</style>`;

writeFileSync(join(DIST, 'index.html'), `<!doctype html>
<html lang="en">
<head>
${head}
</head>
<body>
${body}</body>
</html>
`);

for (const f of ['plan.js', 'airports.js', 'world.js', 'manifest.webmanifest']) copyFileSync(join(ROOT, f), join(DIST, f));
for (const f of ['icon-192.png', 'icon-512.png', 'maskable-512.png', 'apple-touch-icon.png', 'icon-32.png', 'icon.svg']) copyFileSync(join(ROOT, 'icons', f), join(DIST, 'icons', f));

writeFileSync(join(DIST, 'sw.js'), readFileSync(join(ROOT, 'sw.js'), 'utf8').replace('__BUILD__', build));
writeFileSync(join(DIST, '.nojekyll'), '');
console.log(`built dist/ (build ${build})`);
