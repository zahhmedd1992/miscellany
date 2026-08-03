/* Grain — the command registry.
 *
 * Every action the software can take is declared here, ONCE. The toolbar,
 * the command palette, the keyboard map, the HTTP API and the MCP tool list
 * are all projections of this table — generated, never hand-maintained.
 *
 * That is the answer to two things at the same time:
 *   - the 400-button problem (a toolbar is a filter over this list)
 *   - "easily connectable to the outside world" (the API is this list)
 *
 * If you find yourself writing an endpoint by hand, the architecture has
 * failed and the fix is upstream, here.
 */

export class Registry {
  constructor() {
    this.cmds = new Map();
  }

  /**
   * @param {string} id            'data.sort'
   * @param {object} d
   * @param {string} d.title       human label, used by every surface
   * @param {string} d.group       'Format' | 'Data' | ...
   * @param {object} [d.args]      { name: 'Range'|'Text'|'Number'|'Bool'|'Enum:a|b' }
   * @param {string[]} [d.needs]   capabilities: 'doc.read','doc.write','net','fs'
   * @param {string} [d.key]       'Mod+B'
   * @param {string} d.describe    one line — shown to humans AND to models
   * @param {Function} d.run       (args, ctx) => any
   */
  define(id, d) {
    if (this.cmds.has(id)) throw new Error(`command already defined: ${id}`);
    this.cmds.set(id, { id, args: {}, needs: ['doc.read'], ...d });
    return this;
  }

  get(id) { return this.cmds.get(id); }
  all() { return [...this.cmds.values()]; }

  run(id, args = {}, ctx = {}) {
    const c = this.cmds.get(id);
    if (!c) throw new Error(`unknown command: ${id}`);
    // Capability check. At this stage it is ADVISORY — first-party code only,
    // same JS context, so a determined module could bypass it. Stage 3 moves
    // this behind an IPC boundary where it becomes real. Saying so plainly
    // here so nobody mistakes the check for a sandbox.
    if (ctx.granted) {
      for (const need of c.needs) {
        if (!ctx.granted.has(need)) throw new Error(`capability denied: ${need} for ${id}`);
      }
    }
    return c.run(args, ctx);
  }

  /** Ranked search for the Ctrl+K palette.
   *
   * Ranking matters more than matching. A flat "does the haystack contain
   * these letters" search puts "New" above "Fill down" for the query "fd",
   * because 'f' and 'd' both occur somewhere in New's description. The
   * palette is only a safe replacement for a toolbar if the obvious answer
   * is first, so the title outranks the id, which outranks the description.
   */
  search(q) {
    const s = q.trim().toLowerCase();
    if (!s) return this.all();
    const scored = [];
    for (const c of this.cmds.values()) {
      const title = c.title.toLowerCase();
      const id = c.id.toLowerCase();
      const words = id.replace(/[.]/g, ' ');
      const desc = (c.describe || '').toLowerCase();
      let score = null;
      if (title.startsWith(s)) score = 0;
      else if (title.includes(s)) score = 10 + title.indexOf(s);
      else if (id.includes(s)) score = 40;
      else if (subseq(s, title)) score = 60;
      else if (subseq(s, words)) score = 70;
      else if (desc.includes(s)) score = 100;
      if (score !== null) scored.push([score, c]);
    }
    return scored.sort((a, b) => a[0] - b[0] || a[1].title.localeCompare(b[1].title)).map((x) => x[1]);
  }

  /* ---- projections ---------------------------------------------------- */

  /** The toolbar for a profile. `hide: ['*']` means palette-only. */
  toolbar(profile) {
    const ids = profile.toolbar || [];
    return ids.map((id) => this.cmds.get(id)).filter(Boolean);
  }

  /** Keyboard map: 'Mod+B' -> command id. */
  keymap() {
    const m = new Map();
    for (const c of this.cmds.values()) if (c.key) m.set(normKey(c.key), c.id);
    return m;
  }

  /** HTTP route table. Stage 3 serves this; generating it now proves it is
   *  a projection and not a parallel implementation that can drift. */
  httpRoutes() {
    return this.all().map((c) => ({
      method: c.needs.includes('doc.write') ? 'POST' : 'GET',
      path: `/v1/cmd/${c.id}`,
      params: c.args,
      describe: c.describe,
    }));
  }

  /** MCP tool definitions — what an AI assistant sees. Same source. */
  toMCP() {
    return this.all().map((c) => ({
      name: c.id.replace(/\./g, '_'),
      description: c.describe,
      inputSchema: {
        type: 'object',
        properties: Object.fromEntries(
          Object.entries(c.args).map(([k, t]) => [k, mcpType(t)])
        ),
        required: Object.keys(c.args),
      },
    }));
  }
}

function mcpType(t) {
  if (t === 'Number') return { type: 'number' };
  if (t === 'Bool') return { type: 'boolean' };
  if (t === 'Range') return { type: 'string', description: 'A1-style range, e.g. B4:B16' };
  if (typeof t === 'string' && t.startsWith('Enum:')) return { type: 'string', enum: t.slice(5).split('|') };
  return { type: 'string' };
}

/** Is `needle` a subsequence of `hay`? "fd" ⊂ "fill down". */
function subseq(needle, hay) {
  let i = 0;
  for (const ch of hay) { if (ch === needle[i]) i++; if (i === needle.length) return true; }
  return needle.length === 0;
}

export function normKey(k) {
  return k.toLowerCase().replace('cmd', 'mod').replace('ctrl', 'mod').split('+').sort().join('+');
}

export function eventKey(e) {
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('mod');
  if (e.shiftKey) parts.push('shift');
  if (e.altKey) parts.push('alt');
  parts.push(e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase());
  return parts.sort().join('+');
}
