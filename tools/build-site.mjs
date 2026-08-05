/* Assemble the deployable site. Run: node tools/build-site.mjs
 *
 * There is no bundler and no transform — the app ships exactly the source
 * you can read in src/. "Build" here means copy, then verify that what came
 * out is genuinely self-contained: no bare imports, no remote resources, and
 * every module actually present.
 *
 * Output: dist/
 *   index.html      the front door
 *   app/            every app, byte-identical to src/
 *                     app/index.html    Sheet
 *                     app/deck.html     Deck
 *                     app/compose.html  both, over one document
 *   source/         one source archive per tool on the front door
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeZip } from './make-zip.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

/* ---- the tool list ------------------------------------------------------
 *
 * One array, two consumers: the source archive built for each tool, and the
 * count on the front door. They cannot drift, because if the number in the
 * page stops matching this list's length the build fails below. A page that
 * says "3 tools" over a list of two is the kind of thing nobody notices for
 * a month.
 *
 * compose.html still ships and still works; it is a second view of the same
 * document rather than a third tool, and it is not on the front door. */
const TOOLS = [
  { slug: 'sheet', title: 'Sheet', entry: 'index.html' },
  { slug: 'deck', title: 'Deck', entry: 'deck.html' },
];

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
copyDir(SRC, path.join(DIST, 'app'));

const problems = [];

/* A hyperlink is navigation; a resource is a fetch. Only the second kind can
 * break an offline copy or leak a request, so only the second kind counts —
 * both as a problem below and as an edge of the dependency graph here.
 * <a href="https://mozilla.org/MPL/2.0/"> is fine and correct. */
const RESOURCE_RE = /<(?:link|script|img|iframe|source|video|audio)[^>]*?(?:href|src)\s*=\s*["'](https?:\/\/[^"']+)["']/gi;
const HTML_REF_RE = /<(?:link|script|img|iframe|source|video|audio)\b[^>]*?\b(?:href|src)\s*=\s*["']([^"']+)["']/gi;
const IMPORT_RE = /(?:^|[\s;{(])(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/* ---- what a tool is actually made of -----------------------------------
 *
 * Walked, not listed by hand. Hand-listing gets this wrong in a way you do
 * not see: Sheet's page loads apps/deck/deck.css as well as its own, because
 * Sheet can hold a slide. A curated list drops it, the archive extracts, the
 * file count looks right, and the app comes up unstyled.
 *
 * Both edges matter — <link>/<script> out of the HTML, then imports out of
 * each module, transitively, including the literal dynamic ones. */
function closureOf(entryRel) {
  const seen = new Set();
  const queue = [entryRel];
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    const abs = path.join(SRC, rel);
    if (!fs.existsSync(abs)) { problems.push(`${entryRel}: needs "${rel}", which is not in src/`); continue; }
    seen.add(rel);

    const text = fs.readFileSync(abs, 'utf8');
    const dir = path.posix.dirname(rel);
    const refs = [];
    if (rel.endsWith('.html')) for (const m of text.matchAll(HTML_REF_RE)) refs.push(m[1]);
    if (/\.m?js$/.test(rel)) for (const m of text.matchAll(IMPORT_RE)) refs.push(m[1] || m[2]);

    for (const r of refs) {
      // node:zlib is a branch the browser never takes; https:// and data: are
      // not files of ours. Neither is an edge in this graph.
      if (!r || /^[a-z][a-z0-9+.-]*:/i.test(r) || r.startsWith('#') || r.startsWith('//')) continue;
      queue.push(path.posix.normalize(path.posix.join(dir === '.' ? '' : dir, r)));
    }
  }
  return [...seen].sort();
}

/* Plain ASCII on purpose. This is the file a stranger opens in whatever text
 * editor Windows hands them, and an em dash that arrives as "â€"" makes a
 * download look broken before they have run anything. */
function readme(tool, files) {
  return `Miscellany - ${tool.title}
Complete source, version ${VERSION}.


WHAT THIS IS

  All ${files.length} files this app runs, and nothing else. No framework, no
  CDN, no analytics, no build step, no package to install. What you can
  read here is what executes.


HOW TO RUN IT

  Serve this folder over HTTP, then open it in a browser. One line:

      python -m http.server 8000

  ...then go to   http://localhost:8000/${tool.entry}

  Any static web server does the job: "npx serve", "php -S localhost:8000",
  or the Live Server extension in VS Code.

  What does NOT work is double-clicking ${tool.entry}. Browsers refuse to
  load JavaScript modules over a file:// path, so the page comes up blank.
  That is a browser rule about local files, not a missing piece of this
  download.

  Once it is running, nothing is fetched. Unplug the network and it keeps
  working, because there was never anything to fetch.


LICENCE

  Mozilla Public License 2.0. Full text in LICENSE, plain-terms summary in
  NOTICE. Yours to use, change and redistribute, commercial use included.


WHERE THE REST IS

  https://miscellany.io                        the tools, running
  https://github.com/zahhmedd1992/miscellany   tests, corpus, history
`;
}

/* ---- the source archives ---- */

fs.mkdirSync(path.join(DIST, 'source'), { recursive: true });
const archives = [];

for (const tool of TOOLS) {
  const files = closureOf(tool.entry);
  const folder = `miscellany-${tool.slug}`;
  const entries = files.map((rel) => ({
    name: `${folder}/${rel}`,
    data: fs.readFileSync(path.join(SRC, rel)),
  }));
  entries.push(
    { name: `${folder}/README.txt`, data: readme(tool, files) },
    { name: `${folder}/LICENSE`, data: fs.readFileSync(path.join(ROOT, 'LICENSE')) },
    { name: `${folder}/NOTICE`, data: fs.readFileSync(path.join(ROOT, 'NOTICE')) },
  );

  const name = `miscellany-${tool.slug}-source.zip`;
  const bytes = makeZip(entries);
  fs.writeFileSync(path.join(DIST, 'source', name), bytes);
  archives.push({ ...tool, name, files: files.length, bytes: bytes.length });
}

/* ---- enforce the promise, rather than merely keeping it ----------------
 *
 * The site says your file never leaves your machine. Not shipping any code
 * that would send it is necessary and NOT sufficient: the first deploy to
 * Cloudflare came back with an analytics beacon injected at the edge, on
 * every page, without a line of ours changing. A promise that depends on
 * nobody ever injecting anything is not a promise.
 *
 * So the browser enforces it. `script-src 'self'` means an injected script
 * cannot load, whoever injected it, and `connect-src 'self'` means nothing
 * can be sent anywhere even if it did. Every script here is an external
 * module file — there is not one inline script in the project — so this
 * costs us nothing. Styles are inline in each page, hence 'unsafe-inline'
 * there and nowhere else.
 *
 * blob: is allowed for img and object only because saving a file builds a
 * blob URL and clicks it; it is not a channel to anywhere. */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

fs.writeFileSync(path.join(DIST, '_headers'),
`# Generated by tools/build-site.mjs — do not edit by hand.
/*
  Content-Security-Policy: ${CSP}
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Permissions-Policy: geolocation=(), camera=(), microphone=(), interest-cohort=()
  Cross-Origin-Opener-Policy: same-origin

/source/*
  Content-Type: application/zip
  Content-Disposition: attachment
`);

/* ---- verify the output is self-contained ---- */

const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const f = path.join(d, e.name);
    if (e.isDirectory()) walk(f);
    else files.push(f);
  }
})(DIST);

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

/* ---- verify the front door agrees with the tool list ----
 *
 * The count and the list come from the same array; this is what makes that
 * true of the shipped HTML rather than only of the intention. */
const home = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
const tally = home.match(/<b data-tally="tools">(\d+)<\/b>/);
if (!tally) {
  problems.push('index.html: no <b data-tally="tools">…</b>, so the tool count cannot be checked');
} else if (Number(tally[1]) !== TOOLS.length) {
  problems.push(`index.html: tally says ${tally[1]}, the tool list has ${TOOLS.length}`);
}
for (const t of TOOLS) {
  if (!home.includes(`miscellany-${t.slug}-source.zip`)) {
    problems.push(`index.html: no download link for ${t.title}'s source archive`);
  }
}
for (const m of home.matchAll(/href="\.\/([^"]+)"/g)) {
  const target = path.join(DIST, m[1].replace(/\/$/, '/index.html'));
  if (!fs.existsSync(target)) problems.push(`index.html: links to ./${m[1]}, which is not in dist/`);
}

const bytes = files.reduce((a, f) => a + fs.statSync(f).size, 0);

console.log('');
console.log(`  dist/         ${files.length} files, ${(bytes / 1024).toFixed(0)} KB`);
console.log(`  entry points  /index.html · /app/index.html · /app/deck.html · /app/compose.html`);
for (const a of archives) {
  console.log(`  source        /source/${a.name}  —  ${a.files} files, ${(a.bytes / 1024).toFixed(0)} KB`);
}
console.log('');
if (problems.length) {
  for (const p of problems) console.log('  x ' + p);
  console.log('');
  process.exit(1);
}
console.log(`  self-contained: no bare imports, no remote resources, every module present`);
console.log(`  front door:     ${TOOLS.length} tools listed, ${TOOLS.length} counted, ${archives.length} archives linked`);
console.log('');
