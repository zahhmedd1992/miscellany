/* Grain — the node graph and recalculation scheduler.
 *
 * THIS IS THE PRODUCT. Everything else in Miscellany is a view over it.
 *
 * A node is anything that holds a value and may depend on other nodes:
 *   sheet:budget/B4          a cell
 *   deck:board/s3/chart-1    a chart on a slide
 *   form:intake/total        a computed form field
 *
 * The graph knows nothing about spreadsheets. It cannot parse "B4:B16" —
 * it asks an injected resolver to turn a reference into node ids. That is
 * deliberate: the moment the graph understands A1 notation, it stops being
 * a substrate and becomes a spreadsheet with delusions.
 *
 * Because a chart is an ordinary dependent of a range, "live chart on a
 * slide" needs no integration code. It is the same dirty-propagation walk
 * that updates =SUM(B4:B16).
 */

import { V, ERR, BLANK, isErr, parseInput } from './value.js';

export class Node {
  constructor(id) {
    this.id = id;
    this.raw = '';
    this.ast = null;          // parsed formula, or null for a literal
    this.value = BLANK;
    this.deps = new Set();    // node ids this one reads
    this.dependents = new Set();
    this.dirty = false;
    this.meta = null;         // style, format, etc. — views own this
  }
  get isFormula() { return this.ast !== null; }
}

export class Graph {
  /**
   * @param {object} opts
   * @param {(src:string, ctx:object)=>object} opts.parse    formula source -> AST
   * @param {(ast:object, api:object)=>object} opts.evaluate AST -> Value
   * @param {(ref:object, ctx:object)=>string[]} opts.expand reference -> node ids
   */
  constructor({ parse, evaluate, expand, contextOf }) {
    this.nodes = new Map();
    this._parse = parse;
    this._evaluate = evaluate;
    this._expand = expand;
    // Which context does a node live in? For a sheet cell that is "which
    // sheet", and it decides what a BARE reference like =S28 means. The graph
    // must ask per node: a single fixed context silently resolves every
    // unqualified reference on every sheet to one sheet.
    this._contextOf = contextOf || (() => ({}));
    this._dirty = new Set();
    this._listeners = new Set();
    this._journal = null;
    this._epoch = 0;          // bumps on every committed recalc
  }

  /* ---- access ---------------------------------------------------------- */

  node(id, create = false) {
    let n = this.nodes.get(id);
    if (!n && create) { n = new Node(id); this.nodes.set(id, n); }
    return n;
  }

  value(id) {
    const n = this.nodes.get(id);
    return n ? n.value : BLANK;
  }

  raw(id) {
    const n = this.nodes.get(id);
    return n ? n.raw : '';
  }

  /* ---- mutation -------------------------------------------------------- */

  /** Begin recording an undo journal of [id, oldRaw] pairs. */
  beginJournal() { this._journal = []; return this._journal; }
  endJournal() { const j = this._journal; this._journal = null; return j || []; }

  /** Set a node from raw user input. Returns the set of ids that changed. */
  set(id, raw, ctx = {}) {
    /* A change listener may not change the document.
     *
     * Recalculation notifies listeners; if a listener writes, it re-enters
     * recalculation, which notifies again. Deck's first chart renderer did
     * exactly this — it resolved a range by writing a scratch node while
     * painting — and one keystroke became 496 nested repaints and a stack
     * overflow. Nothing reported it: overflowing the stack leaves no room to
     * run an error handler, so the console stayed empty and the page just
     * went blank.
     *
     * So the invariant is enforced here, where it is cheap and loud. If
     * something must update when a value changes, it is a NODE, not a
     * side-effect in a listener. That is the whole design. */
    this._assertWritable(id);
    const n = this.node(id, true);
    if (n.raw === raw) return new Set();
    /* A literal's value is assigned below, BEFORE recalculation runs — so by
     * the time recalc compares old against new it is comparing the new value
     * with itself, decides nothing changed, and tells no one. Typing into a
     * cell that nothing depends on therefore notified no listener at all.
     *
     * Sheet never noticed because it repaints itself after an edit. A SECOND
     * view of the same document is what makes it matter, and a second view of
     * the same document is the entire product. So remember what was here. */
    const wasValue = n.value;
    // Journal the PREVIOUS raw input, not a whole-document snapshot. A
    // 741,000-cell workbook serialises to ~30MB, so snapshot-per-edit caps
    // undo depth at one or two before memory does. A delta costs bytes.
    if (this._journal) this._journal.push([id, n.raw]);
    n.raw = raw;

    const src = typeof raw === 'string' ? raw : '';
    if (src.startsWith('=') && src.length > 1) {
      try {
        n.ast = this._parse(src.slice(1), ctx);
      } catch (e) {
        n.ast = null;
        n.value = V.err(ERR.NAME);
      }
    } else {
      n.ast = null;
      n.value = parseInput(raw);
    }

    this._rewire(n, ctx);
    this._markDirty(id);
    // a literal that genuinely changed is reported by us; a formula's own
    // change is detected by recalc, which evaluates it against its old value
    const seed = !n.ast && !sameValue(wasValue, n.value) ? new Set([id]) : null;
    return this.recalc(seed);
  }

  /**
   * Set a node's meta — a cell's formatting, a slide object's geometry.
   *
   * Meta must go through the graph for one reason: the undo journal. An app
   * that assigns `node.meta` directly changes the document without recording
   * anything, so the journal comes back empty, the shell files no undo step,
   * and Undo silently reverts the change BEFORE the one you meant. Both apps
   * had this: bold on a cell and font size on a slide were both un-undoable,
   * and neither failed loudly.
   *
   * Values are untouched — meta does not participate in recalculation.
   */
  setMeta(id, meta) {
    this._assertWritable(`${id} (meta)`);
    const n = this.node(id, true);
    // three elements marks a meta entry; set() pushes two
    if (this._journal) this._journal.push([id, n.raw, n.meta === undefined ? null : n.meta]);
    n.meta = meta;
    /* Meta does not participate in RECALCULATION - it holds formatting and
     * geometry, not values - but it is still a change to the document, and a
     * view that is not told about it cannot be correct.
     *
     * Sheet and Deck never noticed the omission because every one of their
     * commands ends in a full repaint from the shell. Doc caches its line
     * breaking per paragraph, so a paragraph whose FORMATTING changed with
     * nobody informed kept its old lines: a bulleted item rendered with no
     * bullet and no indent, on the live site, with the correct data sitting
     * in the node. The listener is where "the document changed" is decided,
     * so this is where it has to be said. */
    this._epoch++;
    this._emit(new Set([id]));
    return n;
  }

  /** Merge fields into a node's meta, preserving the rest. */
  patchMeta(id, fields) {
    const n = this.node(id, true);
    return this.setMeta(id, { ...(n.meta || {}) , ...fields });
  }

  /** Remove a node's content but keep its edges consistent. */
  clear(id, ctx = {}) {
    const n = this.nodes.get(id);
    if (!n) return new Set();
    return this.set(id, '', ctx);
  }

  /* Recompute this node's outgoing dependency edges from its AST. */
  _rewire(n, ctxIgnored) {
    // The node's own context, never the caller's: set() is invoked from all
    // over, and inheriting the caller's sheet wires dependencies to it.
    const ctx = this._contextOf(n.id);
    void ctxIgnored;
    for (const d of n.deps) {
      const dn = this.nodes.get(d);
      if (dn) dn.dependents.delete(n.id);
    }
    n.deps.clear();
    if (!n.ast) return;
    for (const ref of collectRefs(n.ast)) {
      for (const depId of this._expand(ref, ctx)) {
        n.deps.add(depId);
        this.node(depId, true).dependents.add(n.id);
      }
    }
  }

  /* Mark a node and everything transitively downstream as needing recalc. */
  _markDirty(id) {
    const stack = [id];
    while (stack.length) {
      const cur = stack.pop();
      const n = this.nodes.get(cur);
      if (!n || n.dirty) continue;
      n.dirty = true;
      this._dirty.add(cur);
      for (const d of n.dependents) stack.push(d);
    }
  }

  /* ---- recalculation --------------------------------------------------- */

  /**
   * Evaluate every dirty node in dependency order.
   *
   * Kahn's algorithm restricted to the dirty subgraph: a clean node is
   * already correct, so it counts as satisfied. Anything still unresolved
   * when we run out of ready nodes is in a cycle.
   */
  recalc(seed = null) {
    if (this._dirty.size === 0) {
      // nothing to compute, but a literal may still have changed
      if (seed && seed.size) { this._epoch++; this._emit(seed); return seed; }
      return new Set();
    }

    const dirty = this._dirty;
    const indeg = new Map();
    for (const id of dirty) {
      const n = this.nodes.get(id);
      let c = 0;
      for (const d of n.deps) if (dirty.has(d)) c++;
      indeg.set(id, c);
    }

    const ready = [];
    for (const [id, c] of indeg) if (c === 0) ready.push(id);

    const changed = seed ? new Set(seed) : new Set();
    let done = 0;

    while (ready.length) {
      const id = ready.pop();
      const n = this.nodes.get(id);
      done++;

      const before = n.value;
      if (n.ast) {
        n.value = this._safeEval(n);
      }
      // literals already have their value from set(); nothing to do
      n.dirty = false;
      if (!sameValue(before, n.value)) changed.add(id);

      for (const dep of n.dependents) {
        if (!indeg.has(dep)) continue;
        const c = indeg.get(dep) - 1;
        indeg.set(dep, c);
        if (c === 0) ready.push(dep);
      }
    }

    // Whatever remains could never reach in-degree zero => circular.
    if (done < dirty.size) {
      for (const id of dirty) {
        const n = this.nodes.get(id);
        if (!n.dirty) continue;
        n.value = V.err(ERR.CIRC);
        n.dirty = false;
        changed.add(id);
      }
    }

    this._dirty = new Set();
    this._epoch++;
    if (changed.size) this._emit(changed);
    return changed;
  }

  _safeEval(n) {
    try {
      const v = this._evaluate(n.ast, {
        // ROW()/COLUMN() with no argument mean "this cell", so the evaluator
        // has to know which cell it is evaluating. Nothing else needs it.
        self: n.id,
        ctx: this._contextOf(n.id),
        value: (id) => this.value(id),
        expand: (ref, ctx) => this._expand(ref, ctx),
        node: (id) => this.nodes.get(id),
      });
      // A FORMULA never results in blank. `=A1` where A1 is empty shows 0 in
      // Excel, not nothing. Blankness still survives INSIDE evaluation — the
      // argument ISBLANK(A1) sees is untouched — but the top-level result of
      // a formula becomes 0, which is what a reader sees and what a chart
      // plots. A literal empty cell stays blank; only formulas are affected.
      if (!v || v.k === 'blank') return V.num(0);
      // (a range value passes through untouched)
      return v;
    } catch (e) {
      // An evaluator throw is a bug in us, not in the user's formula.
      // Surface it rather than silently producing a plausible wrong number.
      console.error('[grain] eval threw for', n.id, e);
      return V.err(ERR.VALUE);
    }
  }

  /* ---- notification ---------------------------------------------------- */

  onChange(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }

  /* Listeners are told what changed; they must not change anything. See the
   * guard in set(). The flag is cleared in a finally so a throwing listener
   * cannot wedge the document shut. */
  _emit(ids) {
    this._emitting = true;
    try { for (const fn of this._listeners) fn(ids, this._epoch); }
    finally { this._emitting = false; }
  }

  /* ---- persistence ----------------------------------------------------- */

  /* Only raw input is stored. Values are always recomputed, never trusted
   * from disk — a stale cached value that disagrees with its formula is the
   * single most corrosive bug a spreadsheet can have. */
  toJSON() {
    const out = {};
    for (const [id, n] of this.nodes) {
      if (n.raw !== '' || n.meta) out[id] = n.meta ? { r: n.raw, m: n.meta } : n.raw;
    }
    return out;
  }

  loadJSON(data, ctx = {}) {
    // loadJSON writes nodes directly rather than through set(), so it needs
    // the same guard: otherwise a change listener could replace the whole
    // document from inside a recalculation and the invariant set() enforces
    // would only be half true.
    this._assertWritable('the whole document');
    this.nodes.clear();
    this._dirty.clear();
    // Two passes: create every node first so edges can be wired without
    // depending on insertion order.
    for (const id of Object.keys(data)) this.node(id, true);
    for (const [id, v] of Object.entries(data)) {
      const n = this.node(id, true);
      const raw = typeof v === 'string' ? v : v.r;
      if (typeof v !== 'string' && v.m) n.meta = v.m;
      n.raw = raw;
      const src = typeof raw === 'string' ? raw : '';
      if (src.startsWith('=') && src.length > 1) {
        try { n.ast = this._parse(src.slice(1), ctx); }
        catch { n.ast = null; n.value = V.err(ERR.NAME); }
      } else {
        n.ast = null;
        n.value = parseInput(raw);
      }
    }
    for (const n of this.nodes.values()) this._rewire(n, ctx);
    for (const id of this.nodes.keys()) this._markDirty(id);
    const changed = this.recalc();

    /* Opening a file replaces everything, but recalc only reports nodes whose
     * computed value moved — so a document of nothing but literals reports
     * NOTHING, and a view attached before the file was opened would never
     * paint it. Tell listeners the truth: all of it is new.
     *
     * Built only when somebody is listening. A 741,000-cell workbook loaded
     * headlessly (every test, every conversion) pays nothing for this. */
    if (this._listeners.size) {
      const all = new Set(this.nodes.keys());
      this._emit(all);
      return all;
    }
    return changed;
  }

  /** Mutation entry points share one guard so the rule cannot drift apart. */
  _assertWritable(what) {
    if (!this._emitting) return;
    throw new Error(
      `[grain] a change listener tried to write ${what}. Listeners are ` +
      `read-only — model derived state as a node so the scheduler owns it.`);
  }
}

/* ---- helpers ----------------------------------------------------------- */

/** Walk an AST and yield every reference node. Shape-agnostic on purpose. */
export function collectRefs(ast, out = []) {
  if (!ast || typeof ast !== 'object') return out;
  if (ast.t === 'ref' || ast.t === 'range') { out.push(ast); return out; }
  for (const k of Object.keys(ast)) {
    const v = ast[k];
    if (Array.isArray(v)) { for (const c of v) collectRefs(c, out); }
    else if (v && typeof v === 'object') collectRefs(v, out);
  }
  return out;
}

export function sameValue(a, b) {
  if (a === b) return true;
  if (!a || !b || a.k !== b.k) return false;
  switch (a.k) {
    case 'blank':  return true;
    case 'number': return a.d.eq(b.d);
    case 'text':   return a.s === b.s;
    case 'bool':   return a.b === b.b;
    case 'error':  return a.e === b.e;
    case 'range': {
      if (a.ids.length !== b.ids.length) return false;
      for (let i = 0; i < a.values.length; i++) if (!sameValue(a.values[i], b.values[i])) return false;
      return true;
    }
  }
  return false;
}
