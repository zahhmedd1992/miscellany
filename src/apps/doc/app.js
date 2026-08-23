/* Doc - the app descriptor.
 *
 * Doc supplies the same three things Sheet and Deck do: its commands, its
 * toolbar sets, and a surface. Undo, the palette, the keyboard map, the
 * status bar and the .grain file are the shell's and are not written here.
 *
 * ONE DEPARTURE FROM THE OTHER TWO APPS, and it is deliberate.
 *
 * The shell listens for keys on the window and steps aside whenever the focus
 * is inside an <input> or <textarea>, because in Sheet and Deck that means
 * somebody is mid-edit and owns the keyboard. In Doc, being mid-edit is the
 * RESTING STATE - the text input always has focus - so leaving it to the
 * shell would silently disable every shortcut in the product, Ctrl+Z and
 * Ctrl+K included.
 *
 * So Doc handles its own keys, and it does so by CONSULTING THE SHELL'S OWN
 * KEYMAP rather than by writing a switch statement. The projection stays the
 * single source of truth: a command declared with a key still works here, and
 * still works everywhere else, and there is no second table to forget to
 * update.
 */

import { DocView } from './doc.js';
import { pickColour } from '../../core/shell.js';
import { eventKey } from '../../core/commands.js';
import { STYLES, STYLE_LABELS, PAGE_SIZES, countWords, unprintableIn, paraProps }
  from '../../core/text/layout.js';
import { FAMILIES } from '../../core/text/metrics.js';
import { exportPdf } from './pdfout.js';
import { loadDocx, saveToDocx, surveyNote } from './docxio.js';
import {
  paraOf, setPara, blockIds, insertPara, insertBlock, removeBlock, formatRuns,
  formatAcross, packRuns, insertRuns, fieldId, nextFieldNumber, catsId,
  setPageSetup, pageSetup, FIELD_CHAR, bodyId, keyBetween, keyOf, cellId,
} from './model.js';

const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html !== undefined) n.innerHTML = html;
  return n;
};

export const DocApp = {
  id: 'doc',
  title: 'Doc',

  profiles: {
    simple: {
      name: 'Simple mode',
      toolbar: ['doc.open.docx', 'doc.save.docx', 'doc.export.pdf', 'edit.undo', 'edit.redo',
                'doc.style.pick', 'doc.bold', 'doc.italic', 'doc.underline',
                'doc.list.bullet', 'doc.list.number',
                'doc.align.left', 'doc.align.center', 'doc.field'],
    },
    full: {
      name: 'Everything',
      toolbar: ['file.new', 'doc.open.docx', 'doc.save.docx',
                'file.open.doc', 'file.save.doc', 'doc.export.pdf', 'doc.print',
                'edit.undo', 'edit.redo', 'doc.find',
                'doc.style.pick', 'doc.font', 'doc.bigger', 'doc.smaller',
                'doc.bold', 'doc.italic', 'doc.underline', 'doc.strike',
                'doc.colour', 'doc.highlight', 'doc.clear',
                'doc.align.left', 'doc.align.center', 'doc.align.right', 'doc.align.justify',
                'doc.list.bullet', 'doc.list.number', 'doc.indent', 'doc.outdent',
                'doc.spacing',
                'doc.field', 'doc.table.live', 'doc.chart', 'doc.table', 'doc.rule',
                'doc.pagebreak',
                'doc.page.size', 'doc.page.orientation', 'doc.page.margins',
                'doc.header', 'doc.footer', 'doc.count'],
    },
  },

  commands(shell) {
    const view = (ctx) => (ctx.surface && ctx.surface.view) || null;

    /** The paragraphs a command applies to: the selection, or the caret's. */
    const targets = (v) => {
      if (!v || !v.caret) return [];
      const sel = v.selectionRange();
      if (!sel || sel.empty) return [v.caret.id];
      const out = [];
      let on = false;
      for (const b of v.blocks) {
        if (b.id === sel.from.id) on = true;
        if (on && b.kind === 'para') out.push(b.id);
        if (b.id === sel.to.id) break;
      }
      return out.length ? out : [v.caret.id];
    };

    /** Change paragraph properties on every target paragraph. */
    const para = (ctx, fn) => {
      const v = view(ctx); if (!v) return;
      for (const id of targets(v)) {
        const p = paraOf(ctx.doc, id);
        setPara(ctx.doc, id, p.text, p.runs, { ...p.p, ...fn(paraProps(p.p), p.p) });
      }
      v.after();
    };

    /**
     * Change character formatting over the selection.
     *
     * With nothing selected this does NOT silently do nothing - it records a
     * PENDING format that the next typed character picks up, which is what
     * pressing Ctrl+B before typing a word has meant since 1985.
     */
    const chars = (ctx, fn) => {
      const v = view(ctx); if (!v) return;
      const sel = v.selectionRange();
      if (!sel || sel.empty) {
        const p = paraOf(ctx.doc, v.caret.id);
        const at = formatAcross(p.runs, Math.max(0, v.caret.off - 1), v.caret.off);
        v.pending = { ...(v.pending || at), ...fn(v.pending || at) };
        ctx.shell.setStatusNote('formatting applies to what you type next', true);
        return;
      }
      for (const b of v.blocks) {
        if (b.kind !== 'para') continue;
        const i = v.orderIndex(b.id);
        if (i < sel.fromIdx || i > sel.toIdx) continue;
        const from = b.id === sel.from.id ? sel.fromOff : 0;
        const to = b.id === sel.to.id ? sel.toOff : b.text.length;
        if (to <= from) continue;
        const p = paraOf(ctx.doc, b.id);
        setPara(ctx.doc, b.id, p.text,
          packRuns(formatRuns(p.runs, from, to, fn), p.text.length), p.p);
      }
      v.after();
    };

    /** What the selection currently looks like, for a toggle. */
    const current = (v, key) => {
      if (!v || !v.caret) return undefined;
      const sel = v.selectionRange();
      const p = paraOf(v.doc, v.caret.id);
      if (!sel || sel.empty) return (v.pending || {})[key] ??
        formatAcross(p.runs, Math.max(0, v.caret.off - 1), v.caret.off)[key];
      return formatAcross(p.runs, sel.fromOff, sel.toOff)[key];
    };

    shell
      /* ---- file ---- */
      .define('doc.open.docx', {
        title: 'Open .docx', group: 'File', glyph: '⌂', key: 'Mod+O',
        needs: ['doc.write', 'fs'], undoable: false,
        describe: 'Open a Word document. It is read in this browser tab and never uploaded.',
        run: (a, ctx) => {
          const v = view(ctx); if (!v) return;
          pickFile('.docx', async (file) => {
            try {
              const bytes = new Uint8Array(await file.arrayBuffer());
              ctx.shell.undoStack.length = 0;
              ctx.shell.redoStack.length = 0;
              v.docx = await loadDocx(ctx.doc, bytes);
              ctx.shell.docName = file.name.replace(/\.docx$/i, '');
              if (ctx.shell.nameInput) ctx.shell.nameInput.value = ctx.shell.docName;
              /* The file on disk IS the document now, so the shell must stop
               * autosaving a copy of it into browser storage — that is both
               * wrong and, for a real document, impossible. */
              ctx.shell.setAutosave(false);
              v.caret = null;
              v.anchor = null;
              v.dirty = true;
              v.relayout();
              v.draw();
              const note = surveyNote(v.docx.survey);
              ctx.shell.setStatusNote(
                `opened ${v.docx.body.blocks.length} blocks from ${v.docx.survey.parts} parts` +
                (note ? ` · ${note}` : ''), true);
            } catch (e) {
              ctx.shell.setStatusNote('could not open: ' + e.message, false);
            }
          });
        },
      })
      .define('doc.save.docx', {
        title: 'Save .docx', group: 'File', glyph: '⬇', key: 'Mod+S',
        needs: ['doc.read', 'fs'],
        describe: 'Save back to Word format. Everything we did not touch comes back byte for byte.',
        run: async (a, ctx) => {
          const v = view(ctx); if (!v) return;
          if (!v.docx) { ctx.shell.run('file.save.doc'); return; }
          try {
            const r = await saveToDocx(ctx.doc, v.docx);
            download(r.bytes, (ctx.shell.docName || 'document') + '.docx',
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
            ctx.shell.setStatusNote(
              `saved · ${r.edits} change${r.edits === 1 ? '' : 's'} spliced into the original` +
              (r.notes.length ? ` · ${r.notes[0]}` : ''), r.notes.length === 0);
          } catch (e) {
            ctx.shell.setStatusNote('could not save: ' + e.message, false);
          }
        },
      })
      .define('doc.export.pdf', {
        title: 'PDF', group: 'File', glyph: '⎙', needs: ['doc.read', 'fs'],
        describe: 'Save this document as a PDF. The page breaks where you see it break.',
        run: (a, ctx) => {
          const v = view(ctx); if (!v) return;
          // what will be PRINTED, not what is stored: see unprintableIn
          const bad = unprintableIn({ pages: v.pages });
          const r = exportPdf(v, ctx.shell.docName || 'document');
          ctx.shell.setStatusNote(
            `PDF: ${r.pages} page${r.pages === 1 ? '' : 's'}, ${(r.bytes / 1024).toFixed(0)} KB` +
            (bad.length ? ` · ${bad.length} character${bad.length === 1 ? '' : 's'} the ` +
              `built-in fonts cannot print (${bad.slice(0, 6).join(' ')}) shown as ?` : ''),
            bad.length === 0);
        },
      })
      .define('doc.print', {
        title: 'Print', group: 'File', glyph: '🖶', needs: ['doc.read', 'fs'],
        describe: 'Print. Saves a PDF first, because that is the page you are looking at.',
        run: (a, ctx) => { const v = view(ctx); if (v) exportPdf(v, ctx.shell.docName || 'document', true); },
      })

      /* ---- paragraph style ---- */
      .define('doc.style.pick', {
        title: 'Style', group: 'Style', glyph: '¶', needs: ['doc.write'],
        args: { style: 'Enum:' + Object.keys(STYLES).join('|') },
        describe: 'Set the paragraph style: title, heading, body, quote, code, caption.',
        run: (a, ctx) => {
          if (a.style) return para(ctx, () => ({ style: a.style }));
          const v = view(ctx); if (!v) return;
          pickFrom(Object.entries(STYLE_LABELS).map(([k, label]) => ({ k, label })),
            'Paragraph style', (k) => ctx.shell.run('doc.style.pick', { style: k }));
        },
      });

    for (const [k, label] of Object.entries(STYLE_LABELS)) {
      shell.define('doc.style.' + k, {
        title: label, group: 'Style', needs: ['doc.write'],
        key: /^h[123]$/.test(k) ? `Mod+Alt+${k[1]}` : k === 'body' ? 'Mod+Alt+0' : undefined,
        describe: `Make this paragraph ${label.toLowerCase()}.`,
        run: (a, ctx) => para(ctx, () => ({ style: k })),
      });
    }

    shell
      /* ---- character formatting ---- */
      .define('doc.bold', {
        title: 'Bold', group: 'Format', glyph: 'B', key: 'Mod+B', needs: ['doc.write'],
        describe: 'Bold the selected text.',
        run: (a, ctx) => { const on = current(view(ctx), 'b'); chars(ctx, () => ({ b: on ? undefined : 1 })); },
      })
      .define('doc.italic', {
        title: 'Italic', group: 'Format', glyph: 'I', key: 'Mod+I', needs: ['doc.write'],
        describe: 'Italicise the selected text.',
        run: (a, ctx) => { const on = current(view(ctx), 'i'); chars(ctx, () => ({ i: on ? undefined : 1 })); },
      })
      .define('doc.underline', {
        title: 'Underline', group: 'Format', glyph: 'U', key: 'Mod+U', needs: ['doc.write'],
        describe: 'Underline the selected text.',
        run: (a, ctx) => { const on = current(view(ctx), 'u'); chars(ctx, () => ({ u: on ? undefined : 1 })); },
      })
      .define('doc.strike', {
        title: 'Strikethrough', group: 'Format', glyph: 'S', needs: ['doc.write'],
        describe: 'Strike through the selected text.',
        run: (a, ctx) => { const on = current(view(ctx), 's'); chars(ctx, () => ({ s: on ? undefined : 1 })); },
      })
      .define('doc.bigger', {
        title: 'Bigger', group: 'Format', glyph: 'A', needs: ['doc.write'],
        describe: 'Increase the size of the selected text.',
        run: (a, ctx) => sizeStep(ctx, +1),
      })
      .define('doc.smaller', {
        title: 'Smaller', group: 'Format', glyph: 'a', needs: ['doc.write'],
        describe: 'Decrease the size of the selected text.',
        run: (a, ctx) => sizeStep(ctx, -1),
      })
      .define('doc.font', {
        title: 'Font', group: 'Format', glyph: 'ℱ', needs: ['doc.write'],
        args: { family: 'Enum:serif|sans|mono' },
        describe: 'Switch between the serif, sans and monospaced faces.',
        run: (a, ctx) => {
          if (a.family) return chars(ctx, () => ({ f: a.family }));
          pickFrom(Object.entries(FAMILIES).map(([k, f]) => ({ k, label: f.label })),
            'Font', (k) => ctx.shell.run('doc.font', { family: k }));
        },
      })
      .define('doc.colour', {
        title: 'Text colour', group: 'Format', glyph: '◆', needs: ['doc.write'],
        describe: 'Set the colour of the selected text.',
        run: (a, ctx) => pickColour('Text colour',
          (hex) => ctx.shell.run('doc.colour.set', { hex: hex || '' })),
      })
      .define('doc.colour.set', {
        title: 'Set text colour', group: 'Format', needs: ['doc.write'], args: { hex: 'Text' },
        describe: 'Set the selected text to a specific hex colour.',
        run: (a, ctx) => chars(ctx, () => ({ c: a.hex || undefined })),
      })
      .define('doc.highlight', {
        title: 'Highlight', group: 'Format', glyph: '▨', needs: ['doc.write'],
        describe: 'Highlight the selected text.',
        run: (a, ctx) => pickColour('Highlight',
          (hex) => ctx.shell.run('doc.highlight.set', { hex: hex || '' })),
      })
      .define('doc.highlight.set', {
        title: 'Set highlight', group: 'Format', needs: ['doc.write'], args: { hex: 'Text' },
        describe: 'Highlight the selected text in a specific colour.',
        run: (a, ctx) => chars(ctx, () => ({ hl: a.hex || undefined })),
      })
      .define('doc.clear', {
        title: 'Clear formatting', group: 'Format', glyph: '⌫', needs: ['doc.write'],
        describe: 'Strip bold, italics, colour and size from the selected text.',
        run: (a, ctx) => chars(ctx, () => ({
          b: undefined, i: undefined, u: undefined, s: undefined,
          sz: undefined, c: undefined, hl: undefined, f: undefined,
          sup: undefined, sub: undefined,
        })),
      })

      /* ---- paragraph ---- */
      .define('doc.align.left', {
        title: 'Left', group: 'Paragraph', glyph: '⯇', needs: ['doc.write'],
        describe: 'Align this paragraph to the left.',
        run: (a, ctx) => para(ctx, () => ({ align: 'left' })),
      })
      .define('doc.align.center', {
        title: 'Centre', group: 'Paragraph', glyph: '⯀', needs: ['doc.write'],
        describe: 'Centre this paragraph.',
        run: (a, ctx) => para(ctx, () => ({ align: 'center' })),
      })
      .define('doc.align.right', {
        title: 'Right', group: 'Paragraph', glyph: '⯈', needs: ['doc.write'],
        describe: 'Align this paragraph to the right.',
        run: (a, ctx) => para(ctx, () => ({ align: 'right' })),
      })
      .define('doc.align.justify', {
        title: 'Justify', group: 'Paragraph', glyph: '≡', needs: ['doc.write'],
        describe: 'Justify this paragraph: stretch the spaces so both edges line up.',
        run: (a, ctx) => para(ctx, () => ({ align: 'justify' })),
      })
      .define('doc.list.bullet', {
        title: 'Bullets', group: 'Paragraph', glyph: '•', needs: ['doc.write'],
        describe: 'Make these paragraphs a bulleted list.',
        run: (a, ctx) => para(ctx, (eff, raw) => ({ list: raw.list === 'bullet' ? null : 'bullet' })),
      })
      .define('doc.list.number', {
        title: 'Numbers', group: 'Paragraph', glyph: '1.', needs: ['doc.write'],
        describe: 'Make these paragraphs a numbered list.',
        run: (a, ctx) => para(ctx, (eff, raw) => ({ list: raw.list === 'number' ? null : 'number' })),
      })
      .define('doc.indent', {
        title: 'Indent', group: 'Paragraph', glyph: '⇥', needs: ['doc.write'],
        describe: 'Move this paragraph in. In a list, make it a sub-item.',
        run: (a, ctx) => para(ctx, (eff, raw) => raw.list
          ? { level: Math.min(4, (raw.level || 0) + 1) }
          : { indentLeft: Math.min(288, (raw.indentLeft || 0) + 18) }),
      })
      .define('doc.outdent', {
        title: 'Outdent', group: 'Paragraph', glyph: '⇤', needs: ['doc.write'],
        describe: 'Move this paragraph back out.',
        run: (a, ctx) => para(ctx, (eff, raw) => raw.list && (raw.level || 0) > 0
          ? { level: raw.level - 1 }
          : { indentLeft: Math.max(0, (raw.indentLeft || 0) - 18) }),
      })
      .define('doc.spacing', {
        title: 'Line spacing', group: 'Paragraph', glyph: '↕', needs: ['doc.write'],
        args: { line: 'Number' },
        describe: 'Set line spacing: 1, 1.15, 1.5 or 2.',
        run: (a, ctx) => {
          if (a.line) return para(ctx, () => ({ line: Number(a.line) }));
          const order = [1, 1.15, 1.5, 2];
          para(ctx, (eff) => ({ line: order[(order.indexOf(eff.line) + 1) % order.length] }));
        },
      })

      /* ---- insert ---- */
      .define('doc.field', {
        title: 'Live figure', group: 'Insert', glyph: 'ƒ', needs: ['doc.write'],
        args: { formula: 'Text', format: 'Text' },
        describe: 'Insert a number that comes from a formula and updates when its cells do.',
        run: (a, ctx) => {
          const v = view(ctx); if (!v || !v.caret) return;
          const src = a.formula !== undefined ? a.formula
            : prompt('Formula for this figure — e.g. =SUM(main!B4:B6) or =main!B7',
                     '=SUM(main!B4:B6)');
          if (src === null) return;
          const formula = String(src).startsWith('=') ? src : '=' + src;
          ctx.shell.run('doc.field.insert', { formula, format: a.format || '' });
        },
      })
      .define('doc.field.insert', {
        title: 'Insert live figure', group: 'Insert', needs: ['doc.write'],
        args: { formula: 'Text', format: 'Text' },
        describe: 'Insert a live figure with a given formula and number format.',
        run: (a, ctx) => {
          const v = view(ctx); if (!v || !v.caret) return;
          const paraId = v.caret.id;
          const n = nextFieldNumber(ctx.doc, paraId);
          const fid = fieldId(paraId, n);
          /* The field is a NODE with a formula in it, so the scheduler owns
           * it exactly as it owns a cell - which is why editing the sheet
           * updates the sentence, with no code anywhere that connects them. */
          ctx.doc.set(fid, a.formula);
          ctx.doc.setMeta(fid, { field: { fmt: a.format || null } });
          const p = paraOf(ctx.doc, paraId);
          const off = v.caret.off;
          const text = p.text.slice(0, off) + FIELD_CHAR + p.text.slice(off);
          const runs = insertRuns(p.runs, off, 1, { field: fid });
          setPara(ctx.doc, paraId, text, packRuns(runs, text.length), p.p);
          v.caret = { id: paraId, off: off + 1 };
          v.after();
        },
      })
      .define('doc.table.live', {
        title: 'Live table', group: 'Insert', glyph: '▦', needs: ['doc.write'],
        args: { ref: 'Range' },
        describe: 'Insert a table bound to a range of cells. It updates when they do.',
        run: (a, ctx) => {
          const v = view(ctx); if (!v || !v.caret) return;
          const ref = a.ref !== undefined ? a.ref
            : prompt('Which cells should this table show?', 'main!A3:D7');
          if (!ref) return;
          const id = insertBlock(ctx.doc, v.caret.id,
            { kind: 'table', ref, header: true }, '=' + String(ref).replace(/^=/, ''));
          v.selBlock = id;
          v.after();
        },
      })
      .define('doc.chart', {
        title: 'Chart', group: 'Insert', glyph: '▮', needs: ['doc.write'],
        args: { ref: 'Range', cats: 'Range', kind: 'Enum:bar|line|area|pie' },
        describe: 'Insert a chart bound to a range of cells. It updates when they do.',
        run: (a, ctx) => {
          const v = view(ctx); if (!v || !v.caret) return;
          const ref = a.ref !== undefined ? a.ref : prompt('Which cells should the chart plot?', 'main!B4:B6');
          if (!ref) return;
          const cats = a.cats !== undefined ? a.cats : (prompt('Labels for them (optional)', 'main!A4:A6') || '');
          const id = insertBlock(ctx.doc, v.caret.id, {
            kind: 'chart', chart: a.kind || 'bar', w: 440, h: 250,
            ref: String(ref).replace(/^=/, ''),
            cats: cats ? String(cats).replace(/^=/, '') : null,
            color: '#9A3B1B', align: 'center',
          }, '=' + String(ref).replace(/^=/, ''));
          if (cats) ctx.doc.set(catsId(id), '=' + String(cats).replace(/^=/, ''));
          v.selBlock = id;
          v.after();
        },
      })
      .define('doc.table', {
        title: 'Table', group: 'Insert', glyph: '⊞', needs: ['doc.write'],
        args: { rows: 'Number', cols: 'Number' },
        describe: 'Insert a table you type into. Any cell may hold a formula.',
        run: (a, ctx) => {
          const v = view(ctx); if (!v || !v.caret) return;
          const rows = Math.max(1, Math.min(60, Number(a.rows) || 3));
          const cols = Math.max(1, Math.min(12, Number(a.cols) || 3));
          const id = insertBlock(ctx.doc, v.caret.id,
            { kind: 'table', rows, colsN: cols, header: true });
          for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
              setPara(ctx.doc, cellId(id, r, c), r === 0 ? `Column ${c + 1}` : '',
                undefined, { after: 0, before: 0, bold: r === 0 });
            }
          }
          v.after();
        },
      })
      .define('doc.rule', {
        title: 'Divider', group: 'Insert', glyph: '—', needs: ['doc.write'],
        describe: 'Draw a horizontal line under this paragraph.',
        run: (a, ctx) => para(ctx, (eff, raw) => ({ rule: raw.rule ? null : true })),
      })
      .define('doc.pagebreak', {
        title: 'Page break', group: 'Insert', glyph: '⤓', key: 'Mod+Enter', needs: ['doc.write'],
        describe: 'Start the next paragraph on a new page.',
        run: (a, ctx) => {
          const v = view(ctx); if (!v || !v.caret) return;
          insertBlock(ctx.doc, v.caret.id, { kind: 'pagebreak' });
          v.after();
        },
      })

      /* ---- page setup ---- */
      .define('doc.page.size', {
        title: 'Paper size', group: 'Page', glyph: '▭', needs: ['doc.write'],
        args: { size: 'Enum:' + Object.keys(PAGE_SIZES).join('|') },
        describe: 'Set the paper size: US Letter, Legal, A4 or A5.',
        run: (a, ctx) => {
          const v = view(ctx); if (!v) return;
          if (a.size) { setPageSetup(ctx.doc, { size: a.size }); v.zoomLocked = false; v.after(); v.resize(); return; }
          pickFrom(Object.entries(PAGE_SIZES).map(([k, s]) => ({ k, label: s.label })),
            'Paper size', (k) => ctx.shell.run('doc.page.size', { size: k }));
        },
      })
      .define('doc.page.orientation', {
        title: 'Orientation', group: 'Page', glyph: '⟳', needs: ['doc.write'],
        describe: 'Switch between portrait and landscape.',
        run: (a, ctx) => {
          const v = view(ctx); if (!v) return;
          setPageSetup(ctx.doc, { landscape: !pageSetup(ctx.doc).landscape });
          v.zoomLocked = false;
          v.after(); v.resize();
        },
      })
      .define('doc.page.margins', {
        title: 'Margins', group: 'Page', glyph: '⌗', needs: ['doc.write'],
        args: { inches: 'Number' },
        describe: 'Set all four margins, in inches.',
        run: (a, ctx) => {
          const v = view(ctx); if (!v) return;
          const cur = (pageSetup(ctx.doc).margin || { top: 72 }).top / 72;
          const inches = a.inches !== undefined ? Number(a.inches)
            : Number(prompt('Margin, in inches', String(cur)));
          if (!Number.isFinite(inches)) return;
          const pt = Math.max(18, Math.min(216, inches * 72));
          setPageSetup(ctx.doc, { margin: { top: pt, right: pt, bottom: pt, left: pt } });
          v.after();
        },
      })
      .define('doc.header', {
        title: 'Header', group: 'Page', glyph: '⌃', needs: ['doc.write'],
        args: { text: 'Text' },
        describe: 'Text at the top of every page. {PAGE} and {PAGES} become numbers.',
        run: (a, ctx) => bandCmd(ctx, 'header', a.text, view(ctx)),
      })
      .define('doc.footer', {
        title: 'Footer', group: 'Page', glyph: '⌄', needs: ['doc.write'],
        args: { text: 'Text' },
        describe: 'Text at the bottom of every page. {PAGE} and {PAGES} become numbers.',
        run: (a, ctx) => bandCmd(ctx, 'footer', a.text, view(ctx)),
      })

      /* ---- view and help ---- */
      .define('doc.find', {
        title: 'Find', group: 'Edit', glyph: '⌕', key: 'Mod+F',
        describe: 'Find text, and replace it.',
        run: (a, ctx) => { const v = view(ctx); if (v && v.openFind) v.openFind(); },
      })
      .define('doc.count', {
        title: 'Word count', group: 'Help', glyph: '#',
        describe: 'Count the words, characters and paragraphs in this document.',
        run: (a, ctx) => {
          const v = view(ctx); if (!v) return;
          const c = countWords(v.blocks);   // asked for explicitly, so counted fresh
          alert(`${c.words.toLocaleString()} words\n${c.chars.toLocaleString()} characters\n` +
                `${c.paras.toLocaleString()} paragraphs\n${v.pages.length} pages`);
        },
      })
      .define('doc.zoom.in', {
        title: 'Zoom in', group: 'View', glyph: '+',
        describe: 'Make the page bigger on screen. The document does not change.',
        run: (a, ctx) => { const v = view(ctx); if (v) v.setZoom(v.zoom * 1.15); },
      })
      .define('doc.zoom.out', {
        title: 'Zoom out', group: 'View', glyph: '−',
        describe: 'Make the page smaller on screen. The document does not change.',
        run: (a, ctx) => { const v = view(ctx); if (v) v.setZoom(v.zoom / 1.15); },
      })
      .define('doc.zoom.fit', {
        title: 'Fit page', group: 'View', glyph: '⤢',
        describe: 'Fit the page to the window.',
        run: (a, ctx) => { const v = view(ctx); if (v) { v.zoomLocked = false; v.fitZoom(); v.draw(); } },
      });

    function sizeStep(ctx, dir) {
      const v = view(ctx); if (!v) return;
      const STEPS = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 60, 72];
      chars(ctx, (r) => {
        const base = r.sz || paraProps(paraOf(ctx.doc, v.caret.id).p).size;
        let i = STEPS.findIndex((s) => s >= base - 0.01);
        if (i < 0) i = STEPS.length - 1;
        return { sz: STEPS[Math.max(0, Math.min(STEPS.length - 1, i + dir))] };
      });
    }

    function bandCmd(ctx, which, given, v) {
      if (!v) return;
      const now = pageSetup(ctx.doc)[which];
      const text = given !== undefined ? given
        : prompt(`${which === 'header' ? 'Header' : 'Footer'} text ` +
                 `(use {PAGE} for the page number)`,
                 now ? now.text : (which === 'footer' ? 'Page {PAGE} of {PAGES}' : ''));
      if (text === null) return;
      setPageSetup(ctx.doc, {
        [which]: text ? { text, align: which === 'footer' ? 'center' : 'right' } : null,
      });
      v.after();
    }
  },

  /* ---- the surface ------------------------------------------------------ */

  mount(host) {
    const wrap = el('div', 'doc-wrap');
    const scroll = el('div', 'doc-scroll');
    const stick = el('div', 'doc-stick');
    const cv = el('canvas', 'doc-canvas');
    const caretCv = el('canvas', 'doc-caret');
    const spacer = el('div', 'doc-spacer');
    const input = el('textarea', 'doc-input');
    input.spellcheck = false;
    input.autocapitalize = 'off';
    input.autocomplete = 'off';
    stick.append(cv, caretCv, input);
    scroll.append(stick, spacer);
    wrap.append(scroll);
    host.el.appendChild(wrap);

    const view = new DocView(scroll, cv, spacer, input, host);
    view._caretLayer = caretCv;

    /* ---- find and replace ---- */
    const find = el('div', 'doc-find');
    find.innerHTML =
      '<input class="f" placeholder="Find" spellcheck="false" />' +
      '<input class="r" placeholder="Replace with" spellcheck="false" />' +
      '<button class="n" title="Next">Next</button>' +
      '<button class="a" title="Replace all">All</button>' +
      '<button class="x" title="Close">✕</button>';
    wrap.appendChild(find);
    const fIn = find.querySelector('.f'), rIn = find.querySelector('.r');
    const closeFind = () => { find.classList.remove('on'); input.focus(); };
    find.querySelector('.x').onclick = closeFind;
    find.querySelector('.n').onclick = () => view.findNext(fIn.value);
    find.querySelector('.a').onclick = () => {
      const n = view.replaceAll(fIn.value, rIn.value);
      host.shell.setStatusNote(`replaced ${n}`, true);
    };
    for (const box of [fIn, rIn]) {
      box.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
        if (e.key === 'Enter') { e.preventDefault(); view.findNext(fIn.value); }
        e.stopPropagation();
      });
    }
    view.openFind = () => { find.classList.add('on'); fIn.focus(); fIn.select(); };

    /* ---- Doc owns its keyboard ---- */
    input.addEventListener('keydown', (e) => {
      const k = eventKey(e);

      if (k === 'k+mod') { e.preventDefault(); host.shell.openPalette(); return; }
      if (k === 'a+mod') { e.preventDefault(); view.selectAll(); return; }

      // Editing keys come first: a document's Enter is not negotiable.
      const editing = {
        Enter: () => { view.host.batch(() => {
                         if (!view.collapsed()) view.deleteSelection();
                         view.splitParagraph();
                       }); view.after(); },
        Backspace: () => view.backspace(),
        Delete: () => view.forwardDelete(),
        Tab: () => host.shell.run(e.shiftKey ? 'doc.outdent' : 'doc.indent'),
      };
      if (!e.ctrlKey && !e.metaKey && editing[e.key]) {
        e.preventDefault();
        editing[e.key]();
        return;
      }

      const moves = {
        ArrowLeft: e.ctrlKey || e.altKey ? 'wordLeft' : 'left',
        ArrowRight: e.ctrlKey || e.altKey ? 'wordRight' : 'right',
        ArrowUp: 'up', ArrowDown: 'down',
        Home: e.ctrlKey ? 'docStart' : 'home',
        End: e.ctrlKey ? 'docEnd' : 'end',
        PageUp: 'pageUp', PageDown: 'pageDown',
      };
      if (moves[e.key]) { e.preventDefault(); view.move(moves[e.key], e.shiftKey); return; }
      if (e.key === 'Escape') { view.anchor = null; view.selBlock = null; view.draw(); return; }

      /* Everything else that is a shortcut comes from the SHELL'S KEYMAP,
       * which is generated from the command declarations. There is no second
       * table of shortcuts in this file to fall out of step with it. */
      if (host.shell.keymap.has(k)) {
        e.preventDefault();
        host.shell.run(host.shell.keymap.get(k));
        return;
      }
      // and anything left is a character, which arrives through `input`
    });

    /* Clipboard. The browser's own events, so the system clipboard is real -
     * but the DATA is ours, because the textarea holds no document. */
    input.addEventListener('copy', (e) => {
      const t = view.selectedText();
      if (!t) return;
      e.clipboardData.setData('text/plain', t);
      e.preventDefault();
    });
    input.addEventListener('cut', (e) => {
      const t = view.selectedText();
      if (!t) return;
      e.clipboardData.setData('text/plain', t);
      e.preventDefault();
      host.batch(() => view.deleteSelection());
      view.after();
    });
    input.addEventListener('paste', (e) => {
      const t = e.clipboardData.getData('text/plain');
      if (t === undefined || t === null) return;
      e.preventDefault();
      view.insertText(t);
    });

    host.note(`<em class="doc-pagechip"></em>`);
    const chip = host.header.querySelector('.doc-pagechip');

    return {
      view,
      draw() {
        view.draw();
        const c = view.counts || { words: 0 };
        chip.textContent = `${view.pages.length} page${view.pages.length === 1 ? '' : 's'} · ` +
          `${c.words.toLocaleString()} words`;
      },
      teardown() { view.dispose(); },
      reset() {
        /* file.new empties the document, and an empty document has no
         * paragraph to put the caret in. Make the one every new document
         * starts with, or the first keystroke has nowhere to go. */
        const first = insertPara(host.doc, null, [], '', { style: 'body' });
        view.caret = { id: first, off: 0 };
        view.anchor = null;
        view.selBlock = null;
        view.dirty = true;
        view.relayout();
        view.draw();
      },
      resize() { view.resize(); },
      focus() { input.focus(); },
      /* True only while the text pipe genuinely has the keyboard. Returning a
       * blanket `true` would leave the shell deaf while the focus was on a
       * toolbar button. */
      capturing() { return document.activeElement === input; },
      clipboard() { /* handled by the real clipboard events above */ },
      status() {
        const out = [];
        const c = view.counts || { words: 0 };
        out.push(`<b>${view.pages.length}</b> page${view.pages.length === 1 ? '' : 's'}`);
        out.push(`${c.words.toLocaleString()} words`);
        if (view.caret) {
          const p = paraOf(host.doc, view.caret.id);
          const eff = paraProps(p.p);
          out.push(STYLE_LABELS[eff.style] || eff.style);
          const sel = view.selectionRange();
          if (sel && !sel.empty) out.push(`${view.selectedText().length} selected`);
        }
        if (view.selBlock) {
          const n = host.doc.node(view.selBlock, true);
          const kind = n.meta && n.meta.block ? n.meta.block.kind : 'block';
          const deps = [...n.deps];
          out.push(`${kind} selected` + (deps.length ? ` · reads ${deps.length} cells` : ''));
        }
        out.push(`${Math.round(view.zoom * 100)}%`);
        return out;
      },
    };
  },
};

/** A file picker that exists only while it is needed. */
function pickFile(accept, then) {
  const input = el('input');
  input.type = 'file';
  input.accept = accept;
  input.style.display = 'none';
  document.body.appendChild(input);
  input.addEventListener('change', (e) => {
    const f = e.target.files[0];
    input.remove();
    if (f) then(f);
  });
  input.click();
}

/** Hand bytes to the browser as a download. */
function download(bytes, name, mime) {
  const blob = new Blob([bytes], { type: mime });
  const a = el('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 20000);
}

/* A small chooser, used where a colour picker would be used for a colour.
 * The shell owns the colour picker because two apps needed it; this one is
 * Doc's until something else does. */
function pickFrom(items, label, apply) {
  const old = document.querySelector('.gr-picker');
  if (old) old.remove();
  const box = el('div', 'gr-picker', `<div class="gr-pl">${label}</div>`);
  const list = el('div', 'doc-choices');
  for (const it of items) {
    const b = el('button', 'doc-choice', it.label);
    b.onclick = () => { box.remove(); apply(it.k); };
    list.appendChild(b);
  }
  box.appendChild(list);
  document.body.appendChild(box);
  const away = (e) => {
    if (!box.contains(e.target)) { box.remove(); document.removeEventListener('mousedown', away); }
  };
  setTimeout(() => document.addEventListener('mousedown', away), 0);
}
