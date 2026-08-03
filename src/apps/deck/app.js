/* Deck — the app descriptor.
 *
 * This is the whole of Deck's wiring. Compare it with what Sheet's wiring
 * used to be (1,339 lines) and the difference is the shell: undo, the
 * palette, the keyboard map, the toolbar, autosave, the status bar and the
 * colour picker are not here because they are not Deck's business.
 *
 * Deck supplies exactly three things, which is the contract:
 *   its commands, its toolbar sets, and a surface that draws and takes keys.
 *
 * Nothing below knows what a spreadsheet is. `=SUM(main!B4:B6)` in a text box
 * works because a slide object is a node, and the scheduler that recalculates
 * a workbook does not care that this node happens to be drawn as 84px type.
 */

import { DeckView, objId, defineObject, OBJECT, slideId, catsId,
         shiftSlides, SLIDE_W, SLIDE_H } from './deck.js';
import { pickColour } from '../../core/shell.js';
import { toText } from '../../core/value.js';

export const DeckApp = {
  id: 'deck',
  title: 'Deck',

  profiles: {
    simple: {
      name: 'Simple mode',
      toolbar: ['deck.slide.add', 'deck.text.add', 'deck.chart.add',
                'edit.undo', 'edit.redo', 'deck.obj.delete',
                'deck.text.bigger', 'deck.text.smaller', 'deck.text.bold'],
    },
    full: {
      name: 'Everything',
      toolbar: ['file.new', 'deck.slide.add', 'deck.slide.delete',
                'deck.slide.next', 'deck.slide.prev',
                'deck.text.add', 'deck.chart.add', 'deck.obj.delete',
                'edit.undo', 'edit.redo',
                'deck.text.bigger', 'deck.text.smaller', 'deck.text.bold',
                'deck.text.colour', 'deck.chart.kind', 'deck.obj.forward'],
    },
  },

  commands(shell) {
    // The surface the command acts on is whichever pane has focus — the shell
    // passes it in, so nothing here reaches for a global.
    const view = (ctx) => (ctx.surface && ctx.surface.view) || null;
    const sel = (ctx) => {
      const v = view(ctx);
      return v && v.sel ? { v, id: v.sel, node: ctx.doc.node(v.sel, true) } : null;
    };
    const obj = (ctx) => {
      const s = sel(ctx);
      return s && s.node.meta && s.node.meta.object ? s : null;
    };
    /* Geometry and role live in node.meta, exactly as a cell's formatting
     * does. Mutating meta is not a document write the scheduler knows about,
     * so say so explicitly rather than let a repaint be someone's luck. */
    const reshape = (ctx, fn) => {
      const s = obj(ctx);
      if (!s) return;
      // Through the graph, never by assigning node.meta — that is what puts
      // the change in the undo journal. See Graph.setMeta.
      ctx.doc.setMeta(s.id, { object: { ...s.node.meta.object, ...fn(s.node.meta.object) } });
    };

    shell
      .define('deck.slide.add', {
        title: 'New slide', group: 'Slide', glyph: '+', needs: ['doc.write'],
        describe: 'Add a slide after the current one.',
        run: (a, ctx) => {
          const v = view(ctx); if (!v) return;
          const at = v.slide + 1;
          shiftSlides(ctx.doc, at, +1, v.deck);       // make room in the middle
          defineObject(ctx.doc, objId(at, 'title'),
            OBJECT.text(80, 70, 1120, 90, { size: 52, bold: true }), 'Untitled slide');
          v.go(at);
        },
      })
      .define('deck.slide.delete', {
        title: 'Delete slide', group: 'Slide', glyph: '−', needs: ['doc.write'],
        describe: 'Delete the current slide and everything on it.',
        run: (a, ctx) => {
          const v = view(ctx); if (!v || v.slides <= 1) return;
          const at = v.slide;
          for (const { id } of v.objects()) {
            ctx.doc.set(id, ''); ctx.doc.setMeta(id, null);
            ctx.doc.set(catsId(id), '');
          }
          // Everything after it moves down one. Lowering a counter instead
          // left the last slide's objects stranded past the end of the deck.
          shiftSlides(ctx.doc, at + 1, -1, v.deck);
          v.go(Math.min(at, v.slides - 1));
        },
      })
      .define('deck.slide.next', {
        title: 'Next slide', group: 'Slide', glyph: '›', key: 'PageDown',
        describe: 'Go to the next slide.',
        run: (a, ctx) => { const v = view(ctx); if (v) v.go(v.slide + 1); },
      })
      .define('deck.slide.prev', {
        title: 'Previous slide', group: 'Slide', glyph: '‹', key: 'PageUp',
        describe: 'Go to the previous slide.',
        run: (a, ctx) => { const v = view(ctx); if (v) v.go(v.slide - 1); },
      })

      .define('deck.text.add', {
        title: 'Text box', group: 'Insert', glyph: 'T', needs: ['doc.write'],
        args: { text: 'Text' },
        describe: 'Add a text box. Its content may be a formula, so it can be a live figure.',
        run: (a, ctx) => {
          const v = view(ctx); if (!v) return;
          const id = objId(v.slide, 'text' + Date.now().toString(36));
          defineObject(ctx.doc, id, OBJECT.text(120, 300, 700, 70, { size: 32 }),
            a.text || 'Text');
          v.select(id);
        },
      })
      .define('deck.chart.add', {
        title: 'Chart', group: 'Insert', glyph: '▮', needs: ['doc.write'],
        args: { ref: 'Range', cats: 'Range' },
        describe: 'Add a chart bound to a range of cells. It updates when they do.',
        run: (a, ctx) => {
          const v = view(ctx); if (!v) return;
          const id = objId(v.slide, 'chart' + Date.now().toString(36));
          defineObject(ctx.doc, id, OBJECT.chart(120, 240, 900, 400, {
            ref: a.ref || 'main!B4:B6',
            cats: a.cats || 'main!A4:A6',
            chart: 'bar', color: '#9A3B1B',
          }));
          v.select(id);
        },
      })
      .define('deck.obj.delete', {
        title: 'Delete', group: 'Insert', glyph: '×', key: 'Delete', needs: ['doc.write'],
        describe: 'Delete the selected object.',
        run: (a, ctx) => {
          const s = obj(ctx); if (!s) return;
          ctx.doc.set(s.id, '');
          ctx.doc.set(catsId(s.id), '');
          ctx.doc.setMeta(s.id, null);
          s.v.sel = null;
        },
      })
      .define('deck.obj.forward', {
        title: 'Bring forward', group: 'Insert', glyph: '⇧', needs: ['doc.write'],
        describe: 'Draw the selected object on top of the others.',
        run: (a, ctx) => {
          // Objects paint in document order, so "forward" is "last inserted".
          const s = obj(ctx); if (!s) return;
          const raw = ctx.doc.raw(s.id), meta = s.node.meta;
          ctx.doc.set(s.id, '');
          ctx.doc.nodes.delete(s.id);
          ctx.doc.set(s.id, raw);
          ctx.doc.setMeta(s.id, meta);
          s.v.select(s.id);
        },
      })

      .define('deck.text.bigger', {
        title: 'Bigger', group: 'Format', glyph: 'A', needs: ['doc.write'],
        describe: 'Increase the selected text size.',
        run: (a, ctx) => reshape(ctx, (o) => ({ size: Math.min(200, (o.size || 24) + 6) })),
      })
      .define('deck.text.smaller', {
        title: 'Smaller', group: 'Format', glyph: 'a', needs: ['doc.write'],
        describe: 'Decrease the selected text size.',
        run: (a, ctx) => reshape(ctx, (o) => ({ size: Math.max(8, (o.size || 24) - 6) })),
      })
      .define('deck.text.bold', {
        title: 'Bold', group: 'Format', glyph: 'B', key: 'Mod+B', needs: ['doc.write'],
        describe: 'Bold the selected text.',
        run: (a, ctx) => reshape(ctx, (o) => ({ bold: !o.bold })),
      })
      .define('deck.text.colour', {
        title: 'Colour', group: 'Format', glyph: '◆', needs: ['doc.write'],
        describe: 'Set the colour of the selected object.',
        run: (a, ctx) => pickColour('Colour', (hex) =>
          ctx.shell.run('deck.text.colour.set', { hex: hex || '' })),
      })
      .define('deck.text.colour.set', {
        title: 'Set colour', group: 'Format', needs: ['doc.write'], args: { hex: 'Text' },
        describe: 'Set the selected object colour to a specific hex value.',
        run: (a, ctx) => reshape(ctx, () => ({
          color: a.hex || null, ...(obj(ctx)?.node.meta.object.kind === 'chart' ? { color: a.hex } : {}),
        })),
      })
      .define('deck.chart.kind', {
        title: 'Chart type', group: 'Format', glyph: '◫', needs: ['doc.write'],
        args: { kind: 'Enum:bar|line|area|pie' },
        describe: 'Switch the selected chart between bar, line, area and pie.',
        run: (a, ctx) => {
          const order = ['bar', 'line', 'area', 'pie'];
          reshape(ctx, (o) => ({
            chart: a.kind || order[(order.indexOf(o.chart || 'bar') + 1) % order.length],
          }));
        },
      });
  },

  mount(host) {
    const cv = document.createElement('canvas');
    cv.className = 'deck-canvas';
    const editor = document.createElement('input');
    editor.className = 'deck-editor';
    editor.spellcheck = false;
    host.el.append(cv, editor);

    const strip = document.createElement('div');
    strip.className = 'deck-strip';
    host.el.appendChild(strip);

    const view = new DeckView(cv, host.doc);   // slide count is derived
    let editing = null;

    const renderStrip = () => {
      strip.innerHTML = '';
      for (let i = 0; i < view.slides; i++) {
        const b = document.createElement('button');
        b.className = 'deck-sbtn' + (i === view.slide ? ' on' : '');
        b.textContent = String(i + 1);
        b.onclick = () => { view.go(i); renderStrip(); host.refresh(); };
        strip.appendChild(b);
      }
    };

    /** Edit an object's raw content in place — a value, or a formula. */
    const beginEdit = (id) => {
      const node = host.doc.node(id, true);
      const o = node.meta && node.meta.object;
      if (!o || o.kind !== 'text') return;
      const st = view.stage();
      const b = view.boxOf(o, st);
      editing = id;
      editor.style.display = 'block';
      editor.style.left = b.x + 'px';
      editor.style.top = b.y + 'px';
      editor.style.width = Math.max(160, b.w) + 'px';
      editor.style.height = Math.max(28, Math.min(60, b.h)) + 'px';
      editor.style.fontSize = Math.min(28, Math.round((o.size || 24) * st.scale)) + 'px';
      editor.value = host.doc.raw(id);
      editor.focus();
      editor.setSelectionRange(editor.value.length, editor.value.length);
    };

    const endEdit = (keep) => {
      if (!editing) return;
      const id = editing;
      editing = null;
      editor.style.display = 'none';
      if (keep && host.doc.raw(id) !== editor.value) {
        host.batch(() => host.doc.set(id, editor.value));
      }
      cv.focus();
      host.refresh();
    };

    editor.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); endEdit(true); }
      else if (e.key === 'Escape') { e.preventDefault(); endEdit(false); }
      e.stopPropagation();
    });
    editor.addEventListener('blur', () => endEdit(true));

    view.onEdit = beginEdit;
    view.onSelect = () => host.refresh();
    cv.setAttribute('tabindex', '0');

    host.note(`<em>${SLIDE_W}×${SLIDE_H}</em>`);
    renderStrip();

    return {
      view,
      draw() { view.draw(); renderStrip(); },
      teardown() { view.dispose(); },
      /** file.new empties the document, so the slide count derives back to 1.
       *  Without this the view stayed on slide 3 and showed a blank canvas
       *  above a strip whose only button was not highlighted. */
      reset() {
        view.slide = 0;
        view.sel = null;
        endEdit(false);
        renderStrip();
      },
      resize() { view.resize(); },
      focus() { cv.focus(); },
      capturing() { return editing !== null; },
      handleKey(e) {
        if (e.key === 'Enter' && view.sel) { beginEdit(view.sel); return true; }
        if (e.key === 'Escape') { view.select(null); return true; }
        // Arrow keys nudge the selected object — meta, not a document write.
        const step = e.shiftKey ? 20 : 4;
        const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0],
                    ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
        if (d && view.sel) {
          const n = host.doc.node(view.sel, true);
          if (!n.meta || !n.meta.object) return false;
          const o = n.meta.object;
          host.batch(() => host.doc.setMeta(view.sel,
            { object: { ...o, x: Math.max(0, o.x + d[0]), y: Math.max(0, o.y + d[1]) } }));
          view.draw();
          e.preventDefault();
          return true;
        }
        return false;
      },
      status() {
        const out = [`<b>Slide ${view.slide + 1}</b> of ${view.slides}`];
        if (view.sel) {
          const n = host.doc.node(view.sel, true);
          const o = n.meta && n.meta.object;
          const name = view.sel.split('/').pop();
          out.push(`${o ? o.kind : 'object'} <b>${name}</b>`);
          const shown = toText(n.value);
          if (o && o.kind !== 'chart' && shown) {
            out.push(shown.length > 40 ? shown.slice(0, 40) + '…' : shown);
          }
          // Which cells this object reads — straight from the graph.
          const deps = [...n.deps];
          if (deps.length) {
            out.push(`reads ${deps.length} cell${deps.length === 1 ? '' : 's'}`);
          }
        } else {
          out.push(`${view.objects().length} objects`);
        }
        return out;
      },
    };
  },
};

export { slideId };
