/* Assemble the deployable site. Run: node tools/build-site.mjs
 *
 * There is no bundler and no transform — the app ships exactly the source
 * you can read in src/. "Build" here means copy, then verify that what came
 * out is genuinely self-contained: no bare imports, no remote resources, and
 * every module actually present.
 *
 * Output: dist/
 *   index.html      the front door
 *   sheet/          the app, byte-identical to src/
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b);
    else fs.copyFileSync(a, b);
  }
}

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'site', 'index.html'), path.join(DIST, 'index.html'));
copyDir(path.join(ROOT, 'src'), path.join(DIST, 'sheet'));

/* ---- verify the output is self-contained ---- */

const problems = [];
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    if (e.isDirectory()) walk(f);
    else files.push(f);
  }
})(DIST);

  // A hyperlink is navigation; a resource is a fetch. Only the second kind
  // can break an offline copy or leak a request, so only the second kind is
  // a problem. <a href="https://mozilla.org/MPL/2.0/"> is fine and correct.
  const RESOURCE_RE = /<(?:link|script|img|iframe|source|video|audio)[^>]*?(?:href|src)\s*=\s*["'](https?:\/\/[^"']+)["']/gi;

const IMPORT_RE = /(?:^|[\s;{(])(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

for (const f of files.filter((x) => /\.(m?js|html)$/.test(x))) {
  const src = fs.readFileSync(f, 'utf8');
  const rel = path.relative(DIST, f).replace(/\\/g, '/');

  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = m[1] || m[2];
    if (!spec) continue;
    if (spec.startsWith('node:')) {
      // zip.js falls back to node's zlib when DecompressionStream is absent.
      // It is a dynamic import inside a branch the browser never takes, but
      // it must stay dynamic or the browser would try to resolve it.
      if (!/await import\(\s*['"]node:/.test(src)) problems.push(`${rel}: static node import "${spec}"`);
      continue;
    }
    if (!spec.startsWith('.') && !spec.startsWith('/')) {
      problems.push(`${rel}: bare import "${spec}" — the site would need a bundler`);
      continue;
    }
    // the module must actually be there
    const target = path.resolve(path.dirname(f), spec);
    if (!fs.existsSync(target)) problems.push(`${rel}: imports "${spec}", which is not in dist/`);
  }

  for (const m of src.matchAll(RESOURCE_RE)) {
    problems.push(`${rel}: remote resource ${m[1]} — the app must work offline`);
  }
}

const bytes = files.reduce((a, f) => a + fs.statSync(f).size, 0);

console.log('');
console.log(`  dist/         ${files.length} files, ${(bytes / 1024).toFixed(0)} KB`);
console.log(`  entry points  /index.html  and  /sheet/index.html`);
console.log('');
if (problems.length) {
  for (const p of problems) console.log('  x ' + p);
  console.log('');
  process.exit(1);
}
console.log('  self-contained: no bare imports, no remote resources, every module present');
console.log('');
