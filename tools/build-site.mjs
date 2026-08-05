/* Assemble the deployable site. Run: node tools/build-site.mjs
 *
 * The site itself is copied, not compiled — /app/ is byte-identical to src/,
 * so what runs at miscellany.io is the source you can read. "Build" here
 * means copy, then verify the output is genuinely self-contained: no bare
 * imports, no remote resources, every module present.
 *
 * The one thing that IS assembled is the download. See make-single.mjs for
 * why a folder of 34 modules was the wrong artefact to hand a stranger.
 *
 * Output: dist/
 *   index.html      the front door
 *   app/            every app, byte-identical to src/
 *                     app/index.html    Sheet
 *                     app/deck.html     Deck
 *                     app/compose.html  both, over one document
 *   download/       one self-contained HTML file per tool — the whole app
 *                   and its whole source, in the same file
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSingleFile } from './make-single.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');
const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

/* ---- the tool list ------------------------------------------------------
 *
 * One array, two consumers: the downloadable file built for each tool, and
 * the count on the front door. They cannot drift, because if the number in the
 * page stops matching this list's length the build fails below. A page that
 * says "3 tools" over a list of two is the kind of thing nobody notices for
 * a month.
 *
 * compose.html still ships and still works; it is a second view of the same
 * document rather than a third tool, and it is not on the front door. */
const TOOLS = [
  { slug: 'sheet', title: 'Sheet', entry: 'index.html', noun: 'spreadsheet' },
  { slug: 'deck', title: 'Deck', entry: 'deck.html', noun: 'slide deck' },
  /* Single-file tools: authored as ONE html file in site/tool/, everything
   * inline. The served page, the download and the source are the same bytes,
   * so there is nothing to bundle and nothing for a visitor to reconcile. */
  { slug: 'passwords', title: 'Passwords', file: 'tool/passwords.html', noun: 'password generator' },
  { slug: 'qr', title: 'QR', file: 'tool/qr.html', noun: 'QR code maker' },
  { slug: 'verify', title: 'Verify', file: 'tool/verify.html', noun: 'checksum checker' },
  { slug: 'encrypt', title: 'Encrypt', file: 'tool/encrypt.html', noun: 'file encryptor' },
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

/* ---- the safety claim, enforced ---------------------------------------
 *
 * The front door tells a stranger there is no networking code in any of this
 * and invites them to have their own AI confirm it. That sentence is only
 * worth printing if it cannot quietly stop being true, so it is checked here,
 * against the exact bytes that go into the archive and the readable page —
 * not against src/, which is a different set of files.
 *
 * `node:zlib` is the one dynamic import in the project. It is a fallback for
 * a compression API old browsers lack, in a branch a browser never takes, and
 * the readable page says so — a reviewer who spots it should find it already
 * accounted for rather than think they caught something. */
const FORBIDDEN = [
  [/\bfetch\s*\(/, 'fetch('],
  [/\bXMLHttpRequest\b/, 'XMLHttpRequest'],
  [/\bWebSocket\b/, 'WebSocket'],
  [/\bEventSource\b/, 'EventSource'],
  [/\bsendBeacon\b/, 'navigator.sendBeacon'],
  [/\beval\s*\(/, 'eval('],
  [/new\s+Function\s*\(/, 'new Function('],
  [/\bimportScripts\s*\(/, 'importScripts('],
];

function scanForReach(tool, blobs, stage) {
  for (const [rel, buf] of blobs) {
    const text = buf.toString('utf8');
    for (const [re, label] of FORBIDDEN) {
      if (re.test(text)) {
        problems.push(
          `${tool.title} (${stage}): ${rel} contains ${label} — the download promises there ` +
          `is no networking or eval in it. Remove it, or stop making the claim.`);
      }
    }
  }
}

/* ---- one file per tool ------------------------------------------------
 *
 * Not a zip of 34 modules and not a separate readable copy alongside it.
 * Both of those made the visitor reconcile two things, and a SHA-256 is not
 * a reconciliation anybody outside this trade can perform. One artefact:
 * the file you read is the file that runs, because there is only one file.
 * Double-clicking it works, which a folder of ES modules never can. */

fs.mkdirSync(path.join(DIST, 'download'), { recursive: true });
const builds = [];

for (const tool of TOOLS.filter((t) => t.entry)) {
  const files = closureOf(tool.entry);
  const blobs = new Map(files.map((rel) => [rel, fs.readFileSync(path.join(SRC, rel))]));
  scanForReach(tool, blobs, 'src');

  const { html, script } = makeSingleFile(SRC, files, tool, VERSION, problems);
  const name = `miscellany-${tool.slug}.html`;
  fs.writeFileSync(path.join(DIST, 'download', name), html, 'utf8');

  /* The bundler emits new bytes, and those bytes are what a stranger's AI
   * actually reviews. Scanning only the inputs would leave the shipped
   * artefact unchecked. Scanned on the CODE, not the document: the header
   * comment has to name fetch and eval in order to promise they are absent. */
  scanForReach(tool, new Map([[name, Buffer.from(script, 'utf8')]]), 'bundle');

  // every source file has to have made it in, or "this is the whole program"
  // is false in the one direction nobody would notice
  for (const rel of files) {
    if (!html.includes(rel)) problems.push(`${tool.title}: ${rel} is in the closure but not named in ${name}`);
  }
  builds.push({ ...tool, name, files: files.length, bytes: Buffer.byteLength(html, 'utf8') });
}

/* ---- single-file tools --------------------------------------------------
 *
 * These need no bundler: the file in site/tool/ IS the app, the source and
 * the download. The build's whole job is verification plus two copies —
 * /tool/<slug>.html to use in place, /download/miscellany-<slug>.html to
 * take away — and one number per tool: the SHA-256 of its inline script.
 *
 * That hash goes into a per-path Content-Security-Policy so the SERVED copy
 * executes exactly the script in the file and nothing else. The edge has
 * injected scripts into this site's pages before, twice; with a hash policy
 * an injected inline script simply does not run, whoever spliced it in. The
 * file also carries its own <meta> policy for the copy on somebody's disk. */
fs.mkdirSync(path.join(DIST, 'tool'), { recursive: true });
const toolHashes = new Map();
for (const tool of TOOLS.filter((t) => t.file)) {
  const src = path.join(ROOT, 'site', tool.file);
  if (!fs.existsSync(src)) { problems.push(`${tool.title}: site/${tool.file} does not exist`); continue; }
  const text = fs.readFileSync(src, 'utf8');
  if (text.includes('\r')) problems.push(`${tool.title}: CRLF line endings — the CSP hash must match the exact served bytes, keep LF`);
  scanForReach(tool, new Map([[tool.file, Buffer.from(text, 'utf8')]]), 'file');

  const scripts = [...text.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  if (scripts.length !== 1) {
    problems.push(`${tool.title}: expected exactly one <script> block, found ${scripts.length} — the CSP hash covers one`);
  }
  toolHashes.set(tool.slug, crypto.createHash('sha256').update(scripts[0]?.[1] ?? '', 'utf8').digest('base64'));

  if (!/<meta http-equiv="Content-Security-Policy"/.test(text)) {
    problems.push(`${tool.title}: no <meta> CSP — the downloaded copy must refuse the network on its own`);
  }
  fs.writeFileSync(path.join(DIST, 'tool', `${tool.slug}.html`), text, 'utf8');
  fs.writeFileSync(path.join(DIST, 'download', `miscellany-${tool.slug}.html`), text, 'utf8');
  builds.push({ ...tool, name: `miscellany-${tool.slug}.html`, files: 1, bytes: Buffer.byteLength(text, 'utf8') });
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

# NOT text/html, deliberately — this is the load-bearing line.
#
# Cloudflare rewrites HTML at the edge, and it was doing it here: every
# download left the edge with a <script src="static.cloudflareinsights.com">
# spliced in, 851 bytes we did not write. On this site that beacon is refused
# by our own CSP. In a file sitting in somebody's Downloads folder there is no
# CSP, and it phoned home the moment they opened it — inside the very artefact
# the front door calls "the complete source, with no networking code in it".
#
# The dashboard toggle that stops it is not reachable from here, and a setting
# somebody can flip back is not a guarantee anyway. An edge HTML rewriter does
# not touch a response that is not HTML, so this one does not get the chance.
# The file is still HTML on disk and still opens with a double-click.
# Both paths, and that is not belt-and-braces. Pages 308-redirects a .html
# request to the extensionless form, so a rule written only against the .html
# lands on the REDIRECT and the file itself is served with whatever the edge
# felt like — which is how the beacon got in the first time.
${TOOLS.map((t) => [`/download/miscellany-${t.slug}.html`, `/download/miscellany-${t.slug}`].map((p) => `${p}
  Content-Type: application/octet-stream
  Content-Disposition: attachment; filename="miscellany-${t.slug}.html"
`).join('')).join('')}
# Single-file tools carry their one script INLINE, which the site-wide
# script-src 'self' would refuse — so each tool path replaces the policy with
# one that names the exact SHA-256 of the script in the file. Injected inline
# scripts (the edge has spliced in two kinds here before) do not match the
# hash and do not run. Both path forms again, because of the .html redirect.
${TOOLS.filter((t) => t.file).map((t) => [`/tool/${t.slug}`, `/tool/${t.slug}.html`].map((p) => `${p}
  ! Content-Security-Policy
  Content-Security-Policy: default-src 'none'; script-src 'sha256-${toolHashes.get(t.slug)}'; style-src 'unsafe-inline'; img-src data: blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
`).join('')).join('')}`);

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
  if (!home.includes(`./download/miscellany-${t.slug}.html`)) {
    problems.push(`index.html: no download link for ${t.title}`);
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
for (const b of builds) {
  console.log(`  download      /download/${b.name}  —  ${b.files} source files in 1, ${(b.bytes / 1024).toFixed(0)} KB`);
}
console.log('');
if (problems.length) {
  for (const p of problems) console.log('  x ' + p);
  console.log('');
  process.exit(1);
}
console.log(`  self-contained: no bare imports, no remote resources, every module present`);
console.log(`  front door:     ${TOOLS.length} tools listed, ${TOOLS.length} counted, ${builds.length} downloads linked`);
console.log(`  downloads:      every import resolves, no cycles, no fetch/XHR/WebSocket/beacon/eval/Function — checked on the bundle, not just its inputs`);
console.log('');
