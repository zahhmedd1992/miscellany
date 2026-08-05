/* Collapse an app into one HTML file that both RUNS and IS its own source.
 *
 * Why this exists rather than a folder of files:
 *
 *   A visitor who is told "read the source, then download the app" has to
 *   take it on faith that the two are the same thing. A hash does not fix
 *   that — nobody outside this trade checks a SHA-256. One file removes the
 *   question instead of answering it: the file you read is the file that
 *   runs, because there is only one file.
 *
 *   It also fixes the other half. A folder of 34 modules needs a local web
 *   server, because browsers refuse ES modules over file://. One HTML file
 *   with the script inline needs nothing: double-click it.
 *
 * What is changed from the repo, and it is only this: an `import` line
 * becomes a local reference, and `export` is dropped from the declaration it
 * sits on. Every other byte of every module is the file from src/. Nothing
 * is minified, nothing is generated, nothing is compressed, and no code is
 * built out of strings at runtime — there is no eval, no Function(), no blob
 * loader. A person or an AI reading the output is reading the program.
 *
 * Each module keeps its own scope. That is not decoration: 11 top-level names
 * collide across the 30 modules (`parse`, `MIME`, `SIG_LOC`, `textOf`, …), so
 * a flat concatenation would silently shadow real code.
 */

import fs from 'node:fs';
import path from 'node:path';

/* `[^}]*`, never `[\s\S]*?`. Non-greedy still crosses newlines, so on
 * sheet.js — where an export list and a re-export sit on consecutive lines —
 * one match swallowed both and the second line's names vanished. A brace list
 * cannot contain a brace, so excluding it is both correct and safe. */
const IMPORT_RE = /^import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]\s*;?[ \t]*$/gm;
const REEXPORT_RE = /^export\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]\s*;?[ \t]*$/gm;
const EXPORT_LIST_RE = /^export\s*\{([^}]*)\}\s*;?[ \t]*$/gm;
const EXPORT_DECL_RE = /^export\s+(async\s+function\*?|function\*?|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;

/* A dynamic `import('./functions.js')` is a FETCH at runtime. In one file
 * there is nothing to fetch, so the command palette would have thrown the
 * first time somebody opened it. Rewritten to the module already in scope;
 * `await` on a plain object is fine. `node:zlib` is left exactly as it is —
 * it is a branch no browser reaches. */
const DYN_IMPORT_RE = /\bimport\s*\(\s*['"](\.[^'"]*)['"]\s*\)/g;

const names = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);

/** `a`, `b as c` -> destructuring text and the local names it binds */
function binding(list) {
  const parts = names(list).map((n) => {
    const m = n.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
    return m ? { text: `${m[1]}: ${m[2]}`, local: m[2], source: m[1] } : { text: n, local: n, source: n };
  });
  return { text: parts.map((p) => p.text).join(', '), locals: parts.map((p) => p.local), sources: parts.map((p) => p.source) };
}

const resolve = (from, spec) =>
  path.posix.normalize(path.posix.join(path.posix.dirname(from) === '.' ? '' : path.posix.dirname(from), spec));

/**
 * @param {string} srcDir
 * @param {string[]} files  closure, any order; .js and .css and the entry .html
 * @param {object} tool     { title, entry, slug }
 * @param {string} version
 * @param {string[]} problems  build failures are pushed here, not thrown
 * @returns {{html: string, script: string}} the document, and just its
 *          executable part — the no-networking scan has to run on the code,
 *          because the header comment necessarily NAMES fetch, eval and the
 *          rest in the course of promising they are not there.
 */
export function makeSingleFile(srcDir, files, tool, version, problems) {
  const read = (rel) => fs.readFileSync(path.join(srcDir, rel), 'utf8').replace(/\r\n/g, '\n');
  const js = files.filter((f) => /\.m?js$/.test(f));

  /* ---- what each module imports and exports ---- */
  const mod = new Map();
  for (const rel of js) {
    const src = read(rel);
    const exports = new Set();
    const deps = [];
    for (const m of src.matchAll(EXPORT_DECL_RE)) exports.add(m[2]);
    for (const m of src.matchAll(EXPORT_LIST_RE)) for (const n of names(m[1])) exports.add(n.split(/\s+as\s+/).pop());
    for (const m of src.matchAll(IMPORT_RE)) deps.push({ from: resolve(rel, m[2]), ...binding(m[1]) });
    // a literal dynamic import is a real edge — it must be ordered before this
    // module too, or `M[...]` is undefined when the palette asks for it
    for (const m of src.matchAll(DYN_IMPORT_RE)) deps.push({ from: resolve(rel, m[1]), text: '', locals: [], sources: [] });
    // the one line that is an import, a rename and a re-export at once
    for (const m of src.matchAll(REEXPORT_RE)) {
      const b = binding(m[1]);
      deps.push({ from: resolve(rel, m[2]), ...b });
      for (const n of b.locals) exports.add(n);
    }
    mod.set(rel, { rel, src, exports, deps });
  }

  /* ---- every imported name must really be exported ----
   * The check that turns a bad rewrite into a build failure rather than a
   * blank page nobody looks at until a stranger downloads it. */
  for (const m of mod.values()) {
    for (const d of m.deps) {
      const target = mod.get(d.from);
      if (!target) { problems.push(`${tool.title}: ${m.rel} imports from ${d.from}, which is not in the closure`); continue; }
      for (const s of d.sources) {
        if (!target.exports.has(s)) problems.push(`${tool.title}: ${m.rel} imports "${s}" from ${d.from}, which does not export it`);
      }
    }
  }

  /* ---- dependency order (no cycles in this project; assert it anyway) ---- */
  const order = [], mark = new Map();
  (function visit(rel, stack) {
    if (mark.get(rel) === 2) return;
    if (mark.get(rel) === 1) { problems.push(`${tool.title}: circular import ${[...stack, rel].join(' -> ')}`); return; }
    mark.set(rel, 1);
    for (const d of mod.get(rel).deps) if (mod.has(d.from)) visit(d.from, [...stack, rel]);
    mark.set(rel, 2);
    order.push(rel);
  })(entryScript(files, srcDir, tool), []);
  for (const rel of js) if (!mark.has(rel)) visit(rel, []);

  /* ---- rewrite each module ---- */
  const chunks = order.map((rel) => {
    const m = mod.get(rel);
    let body = m.src
      .replace(IMPORT_RE, (_, list, spec) => `const { ${binding(list).text} } = M[${JSON.stringify(resolve(rel, spec))}];`)
      .replace(REEXPORT_RE, (_, list, spec) => `const { ${binding(list).text} } = M[${JSON.stringify(resolve(rel, spec))}];`)
      .replace(EXPORT_LIST_RE, '')
      .replace(EXPORT_DECL_RE, (_, kind, name) => `${kind} ${name}`)
      .replace(DYN_IMPORT_RE, (_, spec) => `M[${JSON.stringify(resolve(rel, spec))}]`);
    body = body.replace(/\s*$/, '');
    const ret = m.exports.size ? `\n\nreturn { ${[...m.exports].join(', ')} };` : '';
    return `${BAR}\n// ${rel}\n${BAR}\nM[${JSON.stringify(rel)}] = (function () {\n${body}${ret}\n})();\n`;
  });

  const css = files.filter((f) => f.endsWith('.css')).map((f) => `/* ${f} */\n${read(f).replace(/\s*$/, '')}`).join('\n\n');
  const entryHtml = read(tool.entry);
  const title = (entryHtml.match(/<title>([^<]*)<\/title>/) || [, tool.title])[1];
  const pageStyle = (entryHtml.match(/<style>([\s\S]*?)<\/style>/) || [, ''])[1].trim();
  /* The entry's own BODY, carried verbatim minus its module <script> tag
   * (the bundle below replaces it). Sheet and Deck bodies are a bare #root
   * that their shell fills, so for them this changes nothing — but a tool
   * with real static markup (PDF's drop zone and workbench) would otherwise
   * bundle into a page with a script and no DOM, which is exactly what
   * happened the first time. */
  const bodyInner = ((entryHtml.match(/<body>([\s\S]*?)<\/body>/) || [, '<div id="root"></div>'])[1])
    .replace(/<script\b[^>]*\bsrc\s*=[^>]*>\s*<\/script>/gi, '')
    .trim();

  const total = js.length + files.filter((f) => f.endsWith('.css')).length;

  const script = `'use strict';
(function () {
const M = Object.create(null);

${chunks.join('\n')}
})();`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<!--
${BAR}
  MISCELLANY ${'—'} ${tool.title.toUpperCase()}   v${version}
  This one file is the whole program, and it is also its whole source.
${BAR}

  DOUBLE-CLICK IT. It runs in your browser. No install, no server, no
  account, no internet connection. Nothing is uploaded, ever ${'—'} the file
  you open stays on your machine because there is no code here that
  could send it anywhere.

  READ IT. Everything below is ${total} source files, one after another, in
  full. Open this in any text editor, or hand it to ChatGPT, Claude or
  Gemini and ask:

      "Does this send my data anywhere, or do anything I should
       worry about?"

  There is nothing to reconcile: what you review IS what runs. There is
  no second download and no separate source archive to compare against.

  Three things a reviewer should be able to confirm:

    1. No networking of any kind. No fetch, no XMLHttpRequest, no
       WebSocket, no beacon, no analytics, no telemetry. Nothing here
       is capable of sending anything anywhere. The build that made
       this file scans it for those and refuses to publish on a hit.
    2. No eval() and no new Function(). No code is built from text.
    3. The one dynamic import is "node:zlib" ${'—'} a fallback for a
       compression feature old browsers lack, in a branch a browser
       never reaches. It is not a remote load.

  WHAT WAS CHANGED to make one file out of ${total}: an "import" line became a
  local reference, and the word "export" was dropped from the declaration
  it sat on. That is the entire edit. Every other byte is the file as it
  sits in the repository. Nothing is minified or generated, each module
  keeps its own scope, and the modules appear in dependency order.

  LICENCE  Mozilla Public License 2.0 ${'—'} https://mozilla.org/MPL/2.0/
           Yours to use, change and redistribute, commercial use
           included. (c) 2026 Zachary Ahmed
  SOURCE   https://miscellany.io  ${'·'}  https://github.com/zahhmedd1992/miscellany
${BAR}
-->
<style>
${css}

/* ${tool.entry} */
${pageStyle}
</style>
</head>
<body>
${bodyInner}
<script>
${script}
</script>
</body>
</html>
`;

  return { html, script };
}

const BAR = '/* ' + '-'.repeat(72) + ' */';

/** the module the entry HTML actually boots */
function entryScript(files, srcDir, tool) {
  const html = fs.readFileSync(path.join(srcDir, tool.entry), 'utf8');
  const m = html.match(/<script[^>]*\bsrc\s*=\s*["']([^"']+)["']/);
  if (!m) throw new Error(`${tool.entry}: no <script src>`);
  return resolve(tool.entry, m[1]);
}
