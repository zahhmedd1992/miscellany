/* Grain — the shell.
 *
 * The fourth of the four things every Miscellany app stands on: the node
 * graph, the command registry, the capability manifest, and this — the window
 * everything is hosted in.
 *
 * It exists because of an honest measurement. Sheet's wiring was 1,339 lines,
 * larger than the whole spreadsheet app it wired up, and almost none of it was
 * about spreadsheets: undo, the command palette, the keyboard map, the
 * toolbar, autosave, the status bar, the colour picker. A second app written
 * the same way would have re-typed all of it in a slightly different order,
 * and the platform would have been two programs that share a folder.
 *
 * So: everything on screen that is not the document itself lives here, once.
 *
 * An app supplies three things and nothing else —
 *   1. its commands      (definitions; the shell projects them everywhere)
 *   2. its toolbar sets  (which of those commands a given profile shows)
 *   3. a surface         (mount(host) -> something that draws and takes keys)
 *
 * Two consequences worth stating plainly, because they are the point:
 *
 *   Undo is not the app's job. Any command declaring `doc.write` is wrapped in
 *   a journal automatically, so a new command is undoable because it exists,
 *   not because someone remembered. Sheet had `snapshot() … commit()` copied
 *   into 22 command bodies; every one of them was a chance to forget.
 *
 *   Capabilities are checked on every run, always. They used to be `if
 *   (ctx.granted)` with nothing anywhere granting anything — a claim in the
 *   repo that was not true. The shell is where commands actually run, so the
 *   shell is where the manifest is enforced.
 */

import { Registry, eventKey } from './commands.js';
import { serialise, parse as parseDoc, EXT as DOC_EXT, MIME as DOC_MIME } from './docfile.js';

const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
};

/* Capabilities a first-party app holds from the start. Reading and writing
 * the open document are what an editor IS. Reaching the network and reaching
 * the filesystem are not, so they are granted explicitly and visibly. */
export const BASE_CAPABILITIES = ['doc.read', 'doc.write'];

export class Shell {
  /**
   * @param doc              a Grain document (see core/document.js)
   * @param opts.name        product name shown in the title bar
   * @param opts.storageKey  localStorage key for autosave; omit to disable
   * @param opts.grant       extra capabilities, e.g. ['fs']
   */
  constructor(doc, opts = {}) {
    this.doc = doc;
    this.reg = new Registry();
    this.name = opts.name || 'Miscellany';
    this.storageKey = opts.storageKey || null;
    this.granted = new Set([...BASE_CAPABILITIES, ...(opts.grant || [])]);

    this.apps = new Map();       // id -> descriptor
    this.surfaces = new Map();   // id -> live surface
    this.layout = [];            // ids currently on screen, left to right
    this.focus = null;           // id of the surface that gets commands
    this.profile = 'simple';
    this.docName = 'Untitled';

    /* Undo is a JOURNAL OF DELTAS, not a stack of document snapshots.
     * Snapshots are the obvious implementation and they fail on exactly the
     * files that matter: one snapshot of a 741,000-cell workbook is ~30MB, so
     * any sensible memory budget caps undo depth at one. A delta is a handful
     * of [node, previous input] pairs — depth is free and size is
     * proportional to what actually changed. */
    this.undoStack = [];
    this.redoStack = [];
    this._suspend = false;
    this._depth = 0;             // nested command depth; only the outer one journals
    this._dirtyTimer = null;
    this._autosave = true;       // apps that own a real file turn this off

    this._defineBuiltins();
  }

  /* Commands the shell owns because the state they act on is the shell's.
   * Undo lives here, so Undo is defined here — an app that redefined it would
   * be reaching into a stack it does not own. */
  _defineBuiltins() {
    this
      .define('file.new', {
        title: 'New', group: 'File', glyph: '✧', needs: ['doc.write'],
        undoable: false,
        describe: 'Start an empty document.',
        run: (a, ctx) => {
          ctx.shell.undoStack.length = 0;
          ctx.shell.redoStack.length = 0;
          ctx.doc.loadJSON({});
          ctx.shell.docName = 'Untitled';
          if (ctx.shell.nameInput) ctx.shell.nameInput.value = 'Untitled';
          for (const s of ctx.shell.surfaces.values()) if (s.reset) s.reset();
        },
      })
      .define('edit.undo', {
        title: 'Undo', group: 'Edit', glyph: '↶', key: 'Mod+Z', needs: ['doc.write'],
        undoable: false,
        describe: 'Undo the last change.',
        run: (a, ctx) => ctx.shell.undo(),
      })
      .define('edit.redo', {
        title: 'Redo', group: 'Edit', glyph: '↷', key: 'Mod+Shift+Z', needs: ['doc.write'],
        undoable: false,
        describe: 'Redo the change that was just undone.',
        run: (a, ctx) => ctx.shell.redo(),
      })
      /* Saving and opening a Miscellany document belong to the SHELL, not to
       * an app, because the document does too. A file holding a sheet and a
       * deck cannot be Sheet's to save — that is how "combined into one dual
       * solution" ends up being a view arrangement with nothing behind it,
       * which is exactly what it was until this existed. */
      .define('file.save.doc', {
        title: 'Save document', group: 'File', glyph: '⬇', needs: ['doc.read', 'fs'],
        describe: 'Save everything — sheets, slides, all of it — as one Miscellany document.',
        run: (a, ctx) => ctx.shell.saveDocument(),
      })
      .define('file.open.doc', {
        title: 'Open document', group: 'File', glyph: '⬆', needs: ['doc.write', 'fs'],
        undoable: false,
        describe: 'Open a Miscellany document. It is read in this browser tab and never uploaded anywhere.',
        run: (a, ctx) => ctx.shell.openDocumentDialog(),
      })
      .define('view.api', {
        title: 'Show API', group: 'View', glyph: '⚯',
        describe: 'Show the HTTP routes and AI tool definitions generated from this command list.',
        run: (a, ctx) => showApi(ctx.shell.reg),
      })
      .define('help.functions', {
        title: 'Function list', group: 'Help', glyph: '?',
        describe: 'List every formula function this document understands.',
        // Formulas are core, not a spreadsheet feature — a slide's text box
        // uses the same engine, so the same list belongs to both.
        run: async () => {
          const { FUNCTION_NAMES } = await import('./functions.js');
          alert(`${FUNCTION_NAMES.length} functions:\n\n` + FUNCTION_NAMES.join('  '));
        },
      });
  }

  /* ---- commands ------------------------------------------------------- */

  /** Define a command. Same signature as Registry.define. */
  define(id, d) { this.reg.define(id, d); return this; }

  /**
   * Run a command: capability check, then undo journalling, then redraw.
   *
   * Everything the software can do goes through here — toolbar, palette,
   * keyboard, and (when it is served) the HTTP and MCP routes. One path means
   * one place to enforce a rule and one place to get it wrong.
   */
  run(id, args = {}) {
    const c = this.reg.get(id);
    if (!c) throw new Error(`unknown command: ${id}`);

    /* Any command that writes the document is journalled automatically, so a
     * new command is undoable because it exists. Undo and Redo are the two
     * that must opt out: they write, but journalling them would record the
     * undo as a fresh change and destroy the redo stack. */
    const writes = c.needs.includes('doc.write') && c.undoable !== false;
    const outer = this._depth === 0;
    if (writes && outer) this._snapshot();
    this._depth++;
    try {
      // Registry.run performs the capability check; the shell always supplies
      // a granted set, so the check is never skipped.
      const out = this.reg.run(id, args, {
        granted: this.granted, shell: this, doc: this.doc,
        surface: this.surfaces.get(this.focus) || null,
      });
      if (writes && outer) { this._commit(); this.markDirty(); }
      return out;
    } finally {
      this._depth--;
      if (outer) this.refresh();
    }
  }

  grant(cap) { this.granted.add(cap); return this; }
  revoke(cap) { this.granted.delete(cap); return this; }

  /* ---- undo ------------------------------------------------------------ */

  _snapshot() { if (!this._suspend) this.doc.beginJournal(); }

  _commit() {
    if (this._suspend) return;
    const j = this.doc.endJournal();
    if (!j.length) return;
    this.undoStack.push(j);
    if (this.undoStack.length > 500) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  /** Apply a journal backwards, returning the inverse for the opposite stack. */
  _applyJournal(j) {
    this._suspend = true;
    const inverse = [];
    for (let i = j.length - 1; i >= 0; i--) {
      const [id, oldRaw, oldMeta] = j[i];
      // A three-element entry carries meta (formatting, geometry); a
      // two-element one is a plain value edit. See Graph.setMeta.
      const isMeta = j[i].length > 2;
      inverse.push(isMeta
        ? [id, this.doc.raw(id), this.doc.node(id, true).meta ?? null]
        : [id, this.doc.raw(id)]);
      if (isMeta) this.doc.setMeta(id, oldMeta);
      this.doc.set(id, oldRaw);
    }
    this._suspend = false;
    this.markDirty();
    return inverse.reverse();
  }

  undo() { if (this.undoStack.length) this.redoStack.push(this._applyJournal(this.undoStack.pop())); }
  redo() { if (this.redoStack.length) this.undoStack.push(this._applyJournal(this.redoStack.pop())); }

  /* ---- apps ------------------------------------------------------------ */

  /**
   * @param a.id        'sheet'
   * @param a.title     'Sheet'
   * @param a.profiles  { simple: {name, toolbar:[ids]}, full: {...} }
   * @param a.commands  (shell) => void   — calls shell.define(...)
   * @param a.mount     (host) => surface — { draw, focus, handleKey, status }
   */
  app(a) { this.apps.set(a.id, a); if (a.commands) a.commands(this); return this; }

  /* ---- chrome ----------------------------------------------------------
   * The shell builds its own DOM. An app's entry point is a bare page and a
   * dozen lines of registration — if a new app had to hand-write a title bar,
   * a toolbar, a palette and a status bar in HTML, we would be back to two
   * programs that share a folder. */

  mount(root, layout) {
    this.root = root;
    root.classList.add('gr-shell');
    root.innerHTML = '';

    const head = el('div', 'gr-title');
    this.brand = el('div', 'gr-brand', `${this.name}`);
    this.nameInput = el('input', 'gr-docname');
    this.nameInput.value = this.docName;
    this.nameInput.spellcheck = false;
    this.nameInput.addEventListener('input', () => {
      this.docName = this.nameInput.value; this.markDirty();
    });
    this.tabs = el('div', 'gr-tabs');
    this.profileBtn = el('button', 'gr-chip');
    this.profileBtn.onclick = () => {
      this.profile = this.profile === 'simple' ? 'full' : 'simple';
      this.renderToolbar();
    };
    head.append(this.brand, this.nameInput, this.tabs, el('div', 'gr-sp'), this.profileBtn);

    this.toolbar = el('div', 'gr-toolbar');
    this.stage = el('div', 'gr-stage');
    this.status = el('div', 'gr-status');

    root.append(head, this.toolbar, this.stage, this.status);
    this._buildPalette(root);
    this._bindKeys();

    this.setLayout(layout || [...this.apps.keys()].slice(0, 1));
    return this;
  }

  /** Put one or more apps on screen, left to right. */
  setLayout(ids) {
    /* Tear the old surfaces down before dropping them.
     *
     * Clicking Sheet -> Deck -> Sheet re-mounts, and a surface that is merely
     * forgotten keeps everything it registered: Sheet added copy/cut/paste
     * listeners to `document`, so after three toggles one Ctrl+C ran four
     * handlers, each writing the clipboard from its OWN detached grid with a
     * stale selection — last one wins, so the clipboard could quietly carry
     * the wrong cells. Both views also kept a document subscription and went
     * on repainting canvases that were no longer on screen. */
    for (const s of this.surfaces.values()) {
      if (s && s.teardown) s.teardown();
    }
    this.layout = Array.isArray(ids) ? ids : [ids];
    this.stage.innerHTML = '';
    this.surfaces.clear();

    /* A canvas surface has to be told its size in device pixels, and the
     * window is not what changes it — the SHELL is. Mounting a second pane
     * halves the first one's width without any window resize firing, so a
     * grid sized while it was full width kept a 3200px backing store in an
     * 800px box and drew everything at half scale.
     *
     * The shell owns the layout, so the shell owns the observer. */
    if (this._ro) this._ro.disconnect();
    this._ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const s = this.surfaces.get(e.target.dataset.app);
        if (s && s.resize) s.resize();
      }
    });

    for (const id of this.layout) {
      const a = this.apps.get(id);
      if (!a) throw new Error(`no such app: ${id}`);
      const pane = el('div', 'gr-pane');
      const hd = el('div', 'gr-pane-hd', `<span>${a.title}</span>`);
      const body = el('div', 'gr-pane-body');
      pane.append(hd, body);
      // Clicking anywhere in a pane makes it the one commands act on. With
      // two apps side by side, "Copy" has to mean something specific.
      pane.addEventListener('mousedown', () => this.setFocus(id), true);
      this.stage.appendChild(pane);

      const surface = a.mount(this._host(id, body, hd));
      this.surfaces.set(id, surface);
      body.dataset.app = id;
      this._ro.observe(body);
    }
    this.setFocus(this.layout[0]);
    this.renderTabs();
    this.renderToolbar();
    this.refresh();
    return this;
  }

  _host(id, body, hd) {
    return {
      id,
      doc: this.doc,
      shell: this,
      el: body,
      header: hd,
      /** Extra chrome in this pane's header (a slide strip, a sheet tab bar). */
      note: (html) => { hd.querySelector('span').insertAdjacentHTML('afterend', html); },
      markDirty: () => this.markDirty(),
      refresh: () => this.refresh(),
      /** Batch several document writes into ONE undo step. */
      batch: (fn) => {
        const outer = this._depth === 0;
        if (outer) this._snapshot();
        this._depth++;
        try { return fn(); }
        finally {
          this._depth--;
          if (outer) { this._commit(); this.markDirty(); this.refresh(); }
        }
      },
    };
  }

  setFocus(id) {
    if (!this.surfaces.has(id)) return;
    this.focus = id;
    [...this.stage.children].forEach((p, i) =>
      p.classList.toggle('on', this.layout[i] === id));
    this.renderToolbar();
    this.renderStatus();
  }

  get surface() { return this.surfaces.get(this.focus) || null; }

  renderTabs() {
    this.tabs.innerHTML = '';
    if (this.apps.size < 2) return;
    for (const [id, a] of this.apps) {
      const b = el('button', 'gr-tab' + (this.layout.includes(id) ? ' on' : ''), a.title);
      b.onclick = () => this.setLayout([id]);
      this.tabs.appendChild(b);
    }
    if (this.apps.size === 2) {
      const both = [...this.apps.keys()];
      const b = el('button', 'gr-tab' + (this.layout.length > 1 ? ' on' : ''), 'Both');
      b.onclick = () => this.setLayout(both);
      this.tabs.appendChild(b);
    }
  }

  /* ---- toolbar: a filter over the registry, never hand-written HTML ---- */

  renderToolbar() {
    const a = this.apps.get(this.focus);
    const profiles = (a && a.profiles) || {};
    const p = profiles[this.profile] || profiles.simple || { name: '', toolbar: [] };
    this.toolbar.innerHTML = '';
    let lastGroup = null;
    const shown = this.reg.toolbar(p);
    for (const c of shown) {
      if (lastGroup && c.group !== lastGroup) this.toolbar.appendChild(el('div', 'gr-tsep'));
      lastGroup = c.group;
      const b = el('button', 'gr-tool',
        `<span class="g">${c.glyph || '•'}</span>${c.title}`);
      b.title = c.describe + (c.key ? `  (${c.key})` : '');
      b.onclick = () => { this.run(c.id); this.surface?.focus(); };
      this.toolbar.appendChild(b);
    }
    const hidden = this.reg.all().length - shown.length;
    this.toolbar.appendChild(el('div', 'gr-more',
      `${hidden} more <kbd>Ctrl</kbd><kbd>K</kbd>`));
    this.profileBtn.textContent = p.name || 'Simple mode';
  }

  /* ---- status ---------------------------------------------------------- */

  renderStatus() {
    const parts = (this.surface && this.surface.status && this.surface.status()) || [];
    this.status.innerHTML = '';
    for (const p of parts) this.status.appendChild(el('span', 'gr-sf', p));
    this.status.appendChild(el('div', 'gr-sp'));
    this.saveNote = el('span', 'gr-save', this._saveText || '');
    if (this._saved) this.saveNote.classList.add('on');
    this.status.appendChild(this.saveNote);
  }

  setStatusNote(text, ok) {
    this._saveText = text;
    this._saved = !!ok;
    this.renderStatus();
  }

  /** Redraw every mounted surface and the chrome that reflects them. */
  refresh() {
    for (const s of this.surfaces.values()) if (s.draw) s.draw();
    this.renderStatus();
  }

  /* ---- palette --------------------------------------------------------- */

  _buildPalette(root) {
    this.palette = el('div', 'gr-palette');
    this.pinput = el('input', 'gr-pinput');
    this.pinput.placeholder = 'Type a command…';
    this.pinput.spellcheck = false;
    this.plist = el('ul', 'gr-plist');
    const box = el('div', 'gr-pbox');
    box.append(this.pinput, this.plist);
    this.palette.appendChild(box);
    root.appendChild(this.palette);

    this._pItems = [];
    this._pIndex = 0;
    this.pinput.addEventListener('input', () => this.renderPalette());
    this.pinput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { this.closePalette(); return; }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const n = this.plist.children.length;
        if (!this._pItems.length) return;
        this.plist.children[this._pIndex]?.classList.remove('sel');
        this._pIndex = (this._pIndex + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
        this.plist.children[this._pIndex]?.classList.add('sel');
        this.plist.children[this._pIndex]?.scrollIntoView({ block: 'nearest' });
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const c = this._pItems[this._pIndex];
        if (c) { this.closePalette(); this.run(c.id); }
      }
      e.stopPropagation();
    });
    this.palette.addEventListener('mousedown', (e) => {
      if (e.target === this.palette) this.closePalette();
    });
  }

  openPalette() {
    this.palette.classList.add('on');
    this.pinput.value = '';
    this.renderPalette();
    this.pinput.focus();
  }

  closePalette() { this.palette.classList.remove('on'); this.surface?.focus(); }

  renderPalette() {
    this._pItems = this.reg.search(this.pinput.value);
    this._pIndex = 0;
    this.plist.innerHTML = '';
    if (!this._pItems.length) {
      this.plist.innerHTML = '<li class="gr-pempty">No command matches that.</li>';
      return;
    }
    this._pItems.forEach((c, i) => {
      const li = el('li', i === 0 ? 'sel' : '',
        `<span class="pg">${c.group}</span><span class="pt">${c.title}</span>` +
        `<span class="pd">${c.describe}</span><span class="pk">${c.key || ''}</span>`);
      li.onclick = () => { this.closePalette(); this.run(c.id); };
      this.plist.appendChild(li);
    });
  }

  /* ---- keyboard: generated from the registry, not a hand-written switch -- */

  _bindKeys() {
    this.keymap = this.reg.keymap();
    window.addEventListener('keydown', (e) => {
      const a = document.activeElement;
      // A surface that is mid-edit owns the keyboard completely.
      if (this.surface && this.surface.capturing && this.surface.capturing()) return;
      if (a === this.pinput || a === this.nameInput) return;
      if (a && /^(INPUT|TEXTAREA)$/.test(a.tagName) && a !== document.body) return;

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault(); this.openPalette(); return;
      }

      const k = eventKey(e);
      // Let the browser's native clipboard events fire; preventing the default
      // here would stop copy/cut/paste ever reaching their handlers.
      if (/^(c|x|v)\+mod$|^mod\+(c|x|v)$/.test(k)) {
        const s = this.surface;
        if (s && s.clipboard) {
          if (k.includes('c')) s.clipboard('copy');
          else if (k.includes('x')) s.clipboard('cut');
        }
        return;
      }
      if (this.keymap.has(k)) { e.preventDefault(); this.run(this.keymap.get(k)); return; }

      const s = this.surface;
      if (s && s.handleKey && s.handleKey(e)) this.renderStatus();
    });
  }

  /** Re-read the registry after an app defines commands late. */
  rebindKeys() { this.keymap = this.reg.keymap(); }

  /* ---- persistence: localStorage, no account, nothing leaves the machine -- */

  markDirty() {
    this.setStatusNote('unsaved', false);
    clearTimeout(this._dirtyTimer);
    // An app holding a real file on disk owns the document; autosaving a copy
    // into localStorage is both wrong and impossible — it caps around 5MB and
    // throws QuotaExceededError from inside a timeout, where nothing listens.
    if (!this.storageKey || !this._autosave) return;
    this._dirtyTimer = setTimeout(() => this.save(false), 900);
  }

  /** Apps call this when they take ownership of a real file, and when they let go.
   *
   * Clearing the note matters: leaving "saved automatically" on screen while
   * an unsaved 5 MB workbook is open is an indicator that lies, and a save
   * indicator that lies is worse than none. */
  setAutosave(on) {
    this._autosave = !!on;
    if (!this._autosave) {
      clearTimeout(this._dirtyTimer);
      this.setStatusNote('', false);
    }
  }

  /* ---- the document as a file ------------------------------------------ */

  /** Write the whole document — every app's nodes — to one .grain file. */
  saveDocument() {
    const text = serialise(this.doc.toJSON(),
      { name: this.docName, app: this.name }, this._unknownRecords || []);
    const blob = new Blob([text], { type: DOC_MIME });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (this.docName || 'document') + DOC_EXT;
    a.click();
    URL.revokeObjectURL(a.href);
    this.setStatusNote(`saved ${Object.keys(this.doc.toJSON()).length} nodes`, true);
  }

  /** Read a .grain file into this document, replacing what is open. */
  openDocument(text) {
    const r = parseDoc(text);
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.doc.loadJSON(r.nodes);
    // Records this build did not understand are held so that saving puts them
    // back. An older build must not quietly strip a newer one's work.
    this._unknownRecords = r.unknown;
    if (r.header && r.header.name) {
      this.docName = r.header.name;
      if (this.nameInput) this.nameInput.value = this.docName;
    }
    for (const s of this.surfaces.values()) if (s.reset) s.reset();
    this.setAutosave(true);
    this.refresh();
    const kept = r.unknown.length ? ` · ${r.unknown.length} records kept untouched` : '';
    this.setStatusNote(
      `opened ${Object.keys(r.nodes).length} nodes${kept}` +
      (r.warnings.length ? ` · ${r.warnings[0]}` : ''), true);
    return r;
  }

  openDocumentDialog() {
    if (!this._docInput) {
      this._docInput = document.createElement('input');
      this._docInput.type = 'file';
      this._docInput.accept = DOC_EXT;
      this._docInput.style.display = 'none';
      this._docInput.addEventListener('change', async (e) => {
        const f = e.target.files[0];
        e.target.value = '';
        if (!f) return;
        try { this.openDocument(await f.text()); }
        catch (ex) { this.setStatusNote('could not open: ' + ex.message, false); }
      });
      this.root.appendChild(this._docInput);
    }
    this._docInput.click();
  }

  save(explicit) {
    if (!this.storageKey) {
      // Silently doing nothing is the worst option: the user pressed Save.
      this.setStatusNote('this page has no local storage — use Save document', false);
      return;
    }
    try {
      localStorage.setItem(this.storageKey, JSON.stringify({
        name: this.docName,
        cells: this.doc.toJSON(),
        saved: new Date().toISOString(),
      }));
      this.setStatusNote(explicit ? 'saved' : 'saved automatically', true);
    } catch {
      // Quota exceeded. Say so rather than leave the indicator lying.
      this.setStatusNote('too large for browser storage', false);
    }
  }

  load() {
    if (!this.storageKey) return false;
    const raw = localStorage.getItem(this.storageKey);
    if (!raw) return false;
    try {
      const d = JSON.parse(raw);
      this.docName = d.name || 'Untitled';
      if (this.nameInput) this.nameInput.value = this.docName;
      this.doc.loadJSON(d.cells || {});
      return true;
    } catch { return false; }
  }
}

/* ---- the API viewer: proof the projection is real, not a diagram ------- */

function showApi(reg) {
  const routes = reg.httpRoutes();
  const mcp = reg.toMCP();
  const w = window.open('', '_blank', 'width=860,height=760');
  w.document.write(`<!doctype html><meta charset="utf-8"><title>Generated API</title>
  <style>
    body{font:13px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;margin:0;padding:2rem;background:#FBF8F2;color:#211C16}
    h1{font-size:1.15rem;margin:0 0 .3rem}
    p.s{color:#6C6356;margin:0 0 1.5rem;max-width:44rem;font-size:.85rem}
    h2{font-size:.72rem;letter-spacing:.1em;text-transform:uppercase;color:#9A3B1B;margin:1.8rem 0 .5rem}
    pre{background:#231E17;color:#EDE6D8;padding:1rem;border-radius:4px;overflow-x:auto;font-size:11.5px;line-height:1.55}
    table{border-collapse:collapse;width:100%;font-size:12px;background:#fff;border:1px solid #E3E0DA;border-radius:4px}
    th{text-align:left;font-size:10px;letter-spacing:.07em;text-transform:uppercase;color:#6C6356;padding:.5rem .7rem;border-bottom:1px solid #CFCAC1;background:#F7F5F1}
    td{padding:.45rem .7rem;border-bottom:1px solid #E3E0DA;font-family:ui-monospace,Consolas,monospace;font-size:11px}
    td.d{font-family:inherit;font-size:12px;color:#4A4338}
  </style>
  <h1>Generated from the command registry</h1>
  <p class="s">Nothing below was written by hand. Every route and every AI tool definition is a
  projection of the same ${reg.all().length} command declarations that produce the toolbar, the
  keyboard shortcuts and the Ctrl+K palette. Add a command and all five surfaces gain it at once —
  which is why they cannot drift apart.</p>
  <h2>HTTP routes</h2>
  <table><tr><th>Method</th><th>Path</th><th>What it does</th></tr>
  ${routes.map((r) => `<tr><td>${r.method}</td><td>${r.path}</td><td class="d">${r.describe}</td></tr>`).join('')}
  </table>
  <h2>MCP tool definitions — what an AI assistant sees</h2>
  <pre>${JSON.stringify(mcp, null, 2).replace(/</g, '&lt;')}</pre>`);
  w.document.close();
}

/* ---- a colour picker, because two apps needed the same one ------------- */

const SWATCHES = [
  '#FFFFFF', '#F7F5F1', '#E3E0DA', '#CFCAC1', '#211C16',
  '#9A3B1B', '#C2703F', '#E8C39E', '#2F5D3A', '#7FA98A',
  '#25506E', '#7FA0BC', '#6B4C7A', '#B08BC4', '#B3902F',
];

/** Show a small swatch grid near the pointer and call back with a hex. */
export function pickColour(label, apply) {
  const old = document.querySelector('.gr-picker');
  if (old) old.remove();
  const box = el('div', 'gr-picker', `<div class="gr-pl">${label}</div>`);
  const grid = el('div', 'gr-pgrid');
  for (const hex of SWATCHES) {
    const b = el('button', 'gr-sw');
    b.style.background = hex;
    b.onclick = () => { box.remove(); apply(hex); };
    grid.appendChild(b);
  }
  const none = el('button', 'gr-pnone', 'None');
  none.onclick = () => { box.remove(); apply(null); };
  box.append(grid, none);
  document.body.appendChild(box);
  const away = (e) => {
    if (!box.contains(e.target)) { box.remove(); document.removeEventListener('mousedown', away); }
  };
  setTimeout(() => document.addEventListener('mousedown', away), 0);
}
