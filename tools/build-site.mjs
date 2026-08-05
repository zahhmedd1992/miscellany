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
 *   download/       one runnable source archive per tool
 *   source/         the same source as one plain-text page per tool, so it can
 *                   be read — by a person or by their own AI — without
 *                   downloading anything first
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
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
  { slug: 'sheet', title: 'Sheet', entry: 'index.html', noun: 'spreadsheet' },
  { slug: 'deck', title: 'Deck', entry: 'deck.html', noun: 'slide deck' },
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

function scanForReach(tool, blobs) {
  for (const [rel, buf] of blobs) {
    const text = buf.toString('utf8');
    for (const [re, label] of FORBIDDEN) {
      if (re.test(text)) {
        problems.push(
          `${tool.title}: ${rel} contains ${label} — the front door promises there is ` +
          `no networking or eval in this source. Remove it, or stop making the claim.`);
      }
    }
  }
}

/* Plain ASCII on purpose. This is the file a stranger opens in whatever text
 * editor Windows hands them, and an em dash that arrives as "â€"" makes a
 * download look broken before they have run anything. */
function readme(tool, files) {
  return `Miscellany - ${tool.title}
Complete source, version ${VERSION}.


TO RUN IT

  This folder needs a web server. One line, run in this folder:

      python -m http.server 8000

  Then open   http://localhost:8000/${tool.entry}

  Double-clicking ${tool.entry} will NOT work. Browsers refuse to load
  JavaScript modules straight off a disk, so the page comes up blank.
  That is a browser rule about local files, not a fault in this download.


WHAT IS IN HERE

  The ${files.length} files this app runs, and nothing else. No framework, no
  CDN, no analytics, nothing to install. Once it is running nothing is
  fetched: unplug the network and it keeps working.

  Want to check the code before you trust it? All of it, as one readable
  page you can also hand to an AI:

      https://miscellany.io/source/${tool.slug}.txt


LICENCE

  Mozilla Public License 2.0 - full text in LICENSE.txt. Yours to use,
  change and redistribute, commercial use included.

  (c) 2026 Zachary Ahmed . https://miscellany.io
`;
}

const RULE = '='.repeat(78);

/* How a file's bytes appear inside the readable page. One function, used both
 * to write it and to check it, so the check cannot drift from the writer. */
const embed = (buf) => buf.toString('utf8').replace(/\r\n/g, '\n').replace(/\s*$/, '');

/* The whole source as one plain-text page.
 *
 * This is the artefact for the person who does not want to download a zip
 * from a stranger, and it is the one their AI can read. text/plain, so a
 * click opens it in the browser rather than saving anything. */
function sourceText(tool, files, blobs, zipName, zipSha) {
  const total = files.reduce((a, f) => a + blobs.get(f).length, 0);
  const head = `${RULE}
 MISCELLANY - ${tool.title.toUpperCase()}
 The complete source code, version ${VERSION}
${RULE}

Every file this app runs - all ${files.length} of them - printed below one after
another, in full. Nothing minified, nothing left out, nothing summarised.
What you read here is what runs in your browser.


WHY THIS FILE EXISTS

  So you do not have to take anybody's word for it, including mine.

  Give this to ChatGPT, Claude, Gemini or any other AI and ask it what the
  code does. A fair thing to ask:

      "This is the complete source code of a free ${tool.noun} app I am
       thinking about using. Does it send my data anywhere, or do
       anything else I should worry about?"

  SAVE THIS PAGE (Ctrl+S, or Cmd+S on a Mac) AND ATTACH THE FILE. That is
  the reliable way, and it is worth the extra ten seconds: this file is
  long, and pasting the link instead makes the AI fetch it - which several
  of them do only in part. A review of the first half of the code reads
  exactly like a review of all of it. Attaching the file has no such limit.

  Three things it should be able to confirm:

    1. There is no networking code here at all. No fetch, no XMLHttpRequest,
       no WebSocket, no beacon, no analytics, no telemetry. Nothing in these
       ${String(files.length).padEnd(2)} files is capable of sending anything anywhere.

    2. There is no eval() and no new Function(). Nothing here builds code out
       of text and runs it.

    3. The one dynamic import is "node:zlib", in zip.js and zipwrite.js. It is
       a fallback for a compression feature that older browsers lack, inside a
       branch a browser never takes. It is not a remote load.

  Points 1 and 2 are not promises. The build that produced this file scans
  these exact bytes for those patterns and refuses to publish if it finds one.


IF YOU PASTED THE LINK ANYWAY, CHECK THIS

  Ask your AI to quote the last line of the file. It should come back saying
  END OF SOURCE, and counting ${files.length} of ${files.length} files.

  If it cannot, it did not read all of this, and whatever it just told you
  covers only the part it saw. Save this page and attach the file instead.

  This is not hypothetical: fetching this exact URL was tested, and the AI
  received roughly the first half before the page was cut off. It said so,
  which is the point of the marker.


THE RUNNABLE COPY

  The same ${files.length} files, as a folder you can run:

      https://miscellany.io/download/${zipName}
      SHA-256  ${zipSha}


LICENCE

  Mozilla Public License 2.0 - https://mozilla.org/MPL/2.0/
  Yours to use, change and redistribute, commercial use included.
  (c) 2026 Zachary Ahmed . https://miscellany.io

`;

  const body = files.map((rel, i) => {
    const buf = blobs.get(rel);
    return `\n${RULE}\n FILE ${i + 1} of ${files.length}  -  ${rel}  -  ${buf.length.toLocaleString('en-US')} bytes\n${RULE}\n\n${embed(buf)}\n`;
  }).join('');

  return `${head}${body}
${RULE}
 END OF SOURCE  -  ${files.length} of ${files.length} files, ${total.toLocaleString('en-US')} bytes.
${RULE}
`;
}

/* ---- the two artefacts, built from one closure ------------------------
 *
 * The page invites you to read the text and then download the zip, so the
 * two must be the same source. They are generated from a single closure in
 * a single pass, and cross-checked below, because "review this, then run
 * that" is theatre if anything can differ between them. */

fs.mkdirSync(path.join(DIST, 'download'), { recursive: true });
fs.mkdirSync(path.join(DIST, 'source'), { recursive: true });
const archives = [];

for (const tool of TOOLS) {
  const files = closureOf(tool.entry);
  const blobs = new Map(files.map((rel) => [rel, fs.readFileSync(path.join(SRC, rel))]));
  scanForReach(tool, blobs);

  const folder = `miscellany-${tool.slug}`;
  const entries = files.map((rel) => ({ name: `${folder}/${rel}`, data: blobs.get(rel) }));
  // Two root files, both with an extension. An extensionless LICENSE earns a
  // Windows "How do you want to open this file?" dialog, which is precisely
  // the moment a non-technical person decides this was a mistake.
  entries.push(
    { name: `${folder}/README.txt`, data: readme(tool, files) },
    { name: `${folder}/LICENSE.txt`, data: fs.readFileSync(path.join(ROOT, 'LICENSE')) },
  );

  const zipName = `miscellany-${tool.slug}-source.zip`;
  const zipBytes = makeZip(entries);
  fs.writeFileSync(path.join(DIST, 'download', zipName), zipBytes);
  const zipSha = crypto.createHash('sha256').update(zipBytes).digest('hex');

  const txtName = `${tool.slug}.txt`;
  const txtPath = path.join(DIST, 'source', txtName);
  // utf8, NOT 'ascii'. Node's 'ascii' encoding masks the high bit, so the very
  // first em dash in the very first file came out as a mangled space and the
  // readable copy silently stopped being the code it claims to be. The whole
  // feature rests on those two being the same bytes.
  fs.writeFileSync(txtPath, sourceText(tool, files, blobs, zipName, zipSha), 'utf8');

  /* Read it back off disk before checking it. Verifying the string still in
   * memory would have passed straight through the encoding bug above — the
   * corruption happened on the way out. */
  const written = fs.readFileSync(txtPath, 'utf8');
  const listed = [...written.matchAll(/^ FILE \d+ of \d+ {2}- {2}(\S+) {2}- /gm)].map((m) => m[1]);
  for (const rel of listed) {
    if (!files.includes(rel)) problems.push(`${tool.title}: ${txtName} lists ${rel}, which is not in the zip`);
  }
  for (const rel of files) {
    if (!listed.includes(rel)) { problems.push(`${tool.title}: ${rel} is in the zip but not in ${txtName}`); continue; }
    if (!written.includes(embed(blobs.get(rel)))) {
      problems.push(`${tool.title}: ${rel} in ${txtName} is not byte-identical to the copy in the zip`);
    }
  }
  if (!written.trimEnd().endsWith(RULE)) problems.push(`${txtName}: missing the END OF SOURCE marker readers are told to look for`);

  archives.push({ ...tool, zipName, txtName, files: files.length,
                  bytes: zipBytes.length, txtBytes: written.length, sha: zipSha });
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

/download/*
  Content-Type: application/zip
  Content-Disposition: attachment

# Rendered in the browser, deliberately: the whole point of this copy is that
# you can read it — or hand the URL to an AI — without downloading anything.
/source/*
  Content-Type: text/plain; charset=utf-8
  Content-Disposition: inline
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
  if (!home.includes(`./source/${t.slug}.txt`)) {
    problems.push(`index.html: no link to ${t.title}'s readable source — the "check it yourself" offer is unbacked`);
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
  console.log(`  ${a.title.padEnd(6)}        /download/${a.zipName}  —  ${a.files} files, ${(a.bytes / 1024).toFixed(0)} KB`);
  console.log(`  ${''.padEnd(6)}        /source/${a.txtName}  —  readable, ${(a.txtBytes / 1024).toFixed(0)} KB`);
}
console.log('');
if (problems.length) {
  for (const p of problems) console.log('  x ' + p);
  console.log('');
  process.exit(1);
}
console.log(`  self-contained: no bare imports, no remote resources, every module present`);
console.log(`  front door:     ${TOOLS.length} tools listed, ${TOOLS.length} counted, ${archives.length} archives linked`);
console.log(`  source:         no fetch / XHR / WebSocket / beacon / eval / new Function in any shipped file`);
console.log(`  readable == runnable: every file in each .txt is in its .zip, and back`);
console.log('');
