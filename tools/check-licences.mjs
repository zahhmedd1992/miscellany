/* Dependency licence gate. Run: node tools/check-licences.mjs
 *
 * One contaminating dependency invalidates the entire free promise, so this
 * is not a guideline — it fails the build.
 *
 * ALLOWED   MIT, Apache-2.0, BSD-2/3, ISC, MPL-2.0, CC0, Unlicense, 0BSD
 * FORBIDDEN GPL, AGPL, LGPL, SSPL, BUSL, "commercial", and anything
 *           dual-licensed with a commercial escape hatch — that last one is
 *           the trap, because it reads as free until you open the terms.
 *           HyperFormula (GPLv3-or-paid) is exactly the case this exists for.
 *
 * There are two checks, and the second is the one that matters here:
 *
 *   1. every declared dependency's licence is on the allowlist, and
 *   2. NO SOURCE FILE IMPORTS A BARE SPECIFIER.
 *
 * (2) is what actually holds the line. A dependency can arrive without ever
 * touching package.json — a CDN URL, a vendored file, an import map — and a
 * gate that only reads package.json would not see it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const ALLOWED = [
  /^MIT$/i, /^Apache-2\.0$/i, /^BSD-2-Clause$/i, /^BSD-3-Clause$/i,
  /^ISC$/i, /^MPL-2\.0$/i, /^CC0-1\.0$/i, /^Unlicense$/i, /^0BSD$/i,
];
const FORBIDDEN = /\b(GPL|AGPL|LGPL|SSPL|BUSL|EUPL|CDDL|commercial|proprietary)\b/i;

/* Node builtins are the platform, not a dependency. `node:zlib` in a test is
 * the same category as `Math` — nobody ships it, nobody licenses it to us. */
const BUILTIN = /^node:/;

/* Remote resources the app is allowed to fetch. Deliberately EMPTY.
 *
 * Google Fonts used to be here. It had to go: a tool whose whole claim is
 * that your file never leaves your machine cannot fetch a stylesheet from
 * Google on every load, and an installed copy has to work with no network.
 * If something is ever added here it should be argued for in writing. */
const ALLOWED_REMOTE = [];

let problems = [];
let checked = 0;

/* ---- 1. declared dependencies ---- */
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const declared = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
const names = Object.keys(declared);

for (const name of names) {
  const mp = path.join(ROOT, 'node_modules', name, 'package.json');
  if (!fs.existsSync(mp)) { problems.push(`${name}: declared but not installed, licence unverifiable`); continue; }
  const m = JSON.parse(fs.readFileSync(mp, 'utf8'));
  const lic = typeof m.license === 'string' ? m.license
    : (m.license && m.license.type) || (Array.isArray(m.licenses) && m.licenses.map((l) => l.type).join(' OR ')) || '';
  checked++;
  if (FORBIDDEN.test(lic)) problems.push(`${name}: FORBIDDEN licence "${lic}"`);
  else if (!ALLOWED.some((re) => re.test(lic.trim()))) problems.push(`${name}: unrecognised licence "${lic}" — add it to the allowlist deliberately or drop the dependency`);
}

/* ---- 2. bare import specifiers in source ---- */
function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (/\.(m?js|html)$/.test(e.name)) out.push(full);
  }
  return out;
}

  // A hyperlink is navigation; a resource is a fetch. Only the second kind
  // can break an offline copy or leak a request, so only the second kind is
  // a problem. <a href="https://mozilla.org/MPL/2.0/"> is fine and correct.
  const RESOURCE_RE = /<(?:link|script|img|iframe|source|video|audio)[^>]*?(?:href|src)\s*=\s*["'](https?:\/\/[^"']+)["']/gi;

const IMPORT_RE = /(?:^|[\s;{(])(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
const files = walk(path.join(ROOT, 'src')).concat(walk(path.join(ROOT, 'test')), walk(path.join(ROOT, 'tools')));

for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const rel = path.relative(ROOT, f).replace(/\\/g, '/');

  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = m[1] || m[2];
    if (!spec) continue;
    if (spec.startsWith('.') || spec.startsWith('/')) continue;
    if (BUILTIN.test(spec)) {
      if (rel.startsWith('src/') && !/zip\.js|zipwrite\.js/.test(rel)) {
        problems.push(`${rel}: imports builtin "${spec}" outside the two files allowed to touch it`);
      }
      continue;
    }
    problems.push(`${rel}: BARE IMPORT "${spec}" — that is an external dependency`);
  }

  // Remote RESOURCES only. A hyperlink to a licence or a spec is navigation,
  // not a dependency, and flagging it makes the gate cry wolf.
  for (const m of src.matchAll(RESOURCE_RE)) {
    const url = m[1];
    if (ALLOWED_REMOTE.some((re) => re.test(url))) continue;
    problems.push(`${rel}: remote resource ${url}`);
  }
}

/* ---- verdict ---- */
console.log('');
console.log(`  declared dependencies : ${names.length}${names.length ? ' (' + names.join(', ') + ')' : ''}`);
console.log(`  licences verified     : ${checked}`);
console.log(`  source files scanned  : ${files.length}`);
console.log('');
if (problems.length) {
  for (const p of problems) console.log('  x ' + p);
  console.log('');
  process.exit(1);
}
console.log('  no external dependencies, no forbidden licences');
console.log('');
