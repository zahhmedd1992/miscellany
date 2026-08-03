/* Sheet — the app descriptor.
 *
 * What is NOT in this file is the point of it. Undo, the command palette, the
 * keyboard map, the toolbar, autosave, the status bar, the colour picker and
 * app switching all used to live in Sheet's wiring, and none of them were
 * about spreadsheets. They are the shell's now, so Deck got them for free and
 * so will the third app.
 *
 * What IS here is everything that genuinely knows what a spreadsheet is: the
 * grid, the cell editor, the formula bar, .xlsx open and save with
 * preserve-unknown, the style table, structural row/column edits, per-sheet
 * geometry and the sheet tabs.
 *
 * Commands no longer call snapshot()/commit(). Anything declaring `doc.write`
 * is journalled by the shell, so a command is undoable because it exists.
 */

import { makeGraph, Grid, cellId, expand, SHEET, COLS, ROWS } from './sheet.js';
import { indexToCol } from '../../core/formula.js';
import { toText, isBlank } from '../../core/value.js';
import { Decimal } from '../../core/decimal.js';
import { pickColour } from '../../core/shell.js';
import { openXlsx, readSheet, readSheetCharts } from '../../core/ooxml/xlsx.js';
import { writeZip } from '../../core/ooxml/zipwrite.js';
import { setCellRaw, setCellStyle, cellInner } from '../../core/ooxml/edit.js';
import { StyleTable, BUILTIN_IDS } from '../../core/ooxml/stylewrite.js';
import { applyStructural, setColumnWidths, setRowHeights } from '../../core/ooxml/structural.js';
import { translateFormula, adjustReferences, moveCell } from '../../core/ooxml/refs.js';
import { splitRef } from '../../core/ooxml/chart.js';
import { buildPayload, decodePaste, MIME } from './clipboard.js';

/* Fill-down uses the SAME reference translator as shared-formula expansion and
 * paste. Its own regex was a second implementation that would have drifted —
 * and got LOG10(A1) wrong. */
function shiftRefs(src, dr) {
  if (!src.startsWith('=')) return src;
  return '=' + translateFormula(src.slice(1), 0, dr);
}

/** "B4:D9" -> {c0,r0,c1,r1}, 0-based. */
function parseRangeRef(ref) {
  let m = /^([A-Za-z]{1,3})(\d+):([A-Za-z]{1,3})(\d+)$/.exec(ref || '');
  if (!m) {
    // A single cell is a 1x1 range; chart series legitimately use them.
    const one = /^([A-Za-z]{1,3})(\d+)$/.exec(ref || '');
    if (one) m = [null, one[1], one[2], one[1], one[2]];
  }
  if (!m) return null;
  const ci = (t) => { let n = 0; for (const ch of t.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };
  const c0 = ci(m[1]), r0 = parseInt(m[2], 10) - 1, c1 = ci(m[3]), r1 = parseInt(m[4], 10) - 1;
  return { c0: Math.min(c0, c1), r0: Math.min(r0, r1), c1: Math.max(c0, c1), r1: Math.max(r0, r1) };
}

function groupDigits(d) {
  const s = d.toString();
  const [i, f] = s.split('.');
  const neg = i.startsWith('-');
  const digits = neg ? i.slice(1) : i;
  return (neg ? '-' : '') + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (f ? '.' + f : '');
}

export const SheetApp = {
  id: 'sheet',
  title: 'Sheet',

  /* PROFILES — the 400-button answer. A toolbar is a filter, not a codebase. */
  profiles: {
    simple: {
      name: 'Simple mode',
      toolbar: ['file.open', 'file.save.xlsx', 'edit.undo', 'edit.redo', 'edit.copy',
                'edit.paste', 'fmt.bold', 'fmt.currency', 'fmt.percent', 'data.sum',
                'data.sort', 'data.fill.down', 'edit.clear'],
    },
    full: {
      name: 'Everything',
      toolbar: ['file.new', 'file.open', 'file.save.xlsx', 'file.save', 'file.export.csv',
                'edit.undo', 'edit.redo', 'edit.copy', 'edit.cut', 'edit.paste', 'edit.clear',
                'fmt.bold', 'fmt.italic', 'fmt.currency', 'fmt.percent', 'fmt.comma', 'fmt.plain',
                'fmt.fill', 'fmt.textcolor', 'fmt.border.all', 'fmt.border.none',
                'fmt.size.up', 'fmt.size.down',
                'fmt.align.left', 'fmt.align.center', 'fmt.align.right',
                'sheet.insert.row', 'sheet.delete.row', 'sheet.insert.col', 'sheet.delete.col',
                'data.sum', 'data.sort', 'data.fill.down', 'nav.goto', 'view.api', 'help.functions'],
    },
  },

  commands(shell) {
    // The surface a command acts on is whichever pane has focus. The shell
    // hands it over, so nothing here reaches for a global.
    const S = (ctx) => ctx.surface;
    const g = (ctx) => ctx.surface.grid;

    shell
      .define('file.save', {
        title: 'Save', group: 'File', glyph: '⤓', key: 'Mod+S', needs: ['doc.read'],
        describe: 'Save. With a workbook open this writes the .xlsx; otherwise it saves to local browser storage. Nothing leaves your machine either way.',
        run: (a, ctx) => (S(ctx).book ? S(ctx).saveXlsx() : ctx.shell.save(true)),
      })
      .define('file.open', {
        title: 'Open .xlsx', group: 'File', glyph: '⌂', key: 'Mod+O', needs: ['doc.write', 'fs'],
        undoable: false,
        describe: 'Open an Excel workbook. The file is read in this browser tab and never uploaded anywhere.',
        run: (a, ctx) => S(ctx).fileInput.click(),
      })
      .define('file.save.xlsx', {
        title: 'Save .xlsx', group: 'File', glyph: '⤒', needs: ['doc.read', 'fs'],
        describe: 'Write the workbook back out. Every part we did not change comes back byte-for-byte — including charts, pivot tables and macros.',
        run: (a, ctx) => S(ctx).saveXlsx(),
      })
      .define('file.export.csv', {
        title: 'Export CSV', group: 'File', glyph: '⇥', needs: ['doc.read', 'fs'],
        describe: 'Download the used range as a CSV file.',
        run: (a, ctx) => S(ctx).exportCsv(),
      })

      .define('edit.copy', {
        title: 'Copy', group: 'Edit', glyph: '⧉', key: 'Mod+C', needs: ['doc.read'],
        describe: 'Copy the selection. Formulas survive a paste back into Sheet; plain text goes to every other app.',
        run: (a, ctx) => S(ctx).clipboard('copy'),
      })
      .define('edit.cut', {
        title: 'Cut', group: 'Edit', glyph: '✂', key: 'Mod+X', needs: ['doc.write'],
        undoable: false,   // a cut only takes effect when it is pasted
        describe: 'Cut the selection.',
        run: (a, ctx) => S(ctx).clipboard('cut'),
      })
      .define('edit.paste', {
        title: 'Paste', group: 'Edit', glyph: '⎘', key: 'Mod+V', needs: ['doc.write'],
        undoable: false,
        describe: 'Paste at the selection, shifting relative references by how far the paste moved.',
        run: (a, ctx) => S(ctx).say('press Ctrl+V — the browser only releases the clipboard to a real paste'),
      })
      .define('edit.clear', {
        title: 'Clear', group: 'Edit', glyph: '×', needs: ['doc.write'],
        describe: 'Clear the contents of the selected cells.',
        run: (a, ctx) => {
          const r = g(ctx).selRect();
          for (let row = r.r0; row <= r.r1; row++)
            for (let col = r.c0; col <= r.c1; col++)
              ctx.doc.set(cellId(col, row, g(ctx).sheet), '');
        },
      })

      .define('fmt.bold', {
        title: 'Bold', group: 'Format', glyph: 'B', key: 'Mod+B', needs: ['doc.write'],
        describe: 'Bold the selected cells.',
        run: (a, ctx) => S(ctx).applyFormat((cur) => ({ bold: !cur.bold })),
      })
      .define('fmt.italic', {
        title: 'Italic', group: 'Format', glyph: 'I', key: 'Mod+I', needs: ['doc.write'],
        describe: 'Italicise the selected cells.',
        run: (a, ctx) => S(ctx).applyFormat((cur) => ({ italic: !cur.italic })),
      })
      .define('fmt.currency', {
        title: 'Currency', group: 'Format', glyph: '$', needs: ['doc.write'],
        describe: 'Format as currency with two decimals.',
        run: (a, ctx) => S(ctx).applyFormat(() => ({ numFmtCode: '"$"#,##0.00' })),
      })
      .define('fmt.percent', {
        title: 'Percent', group: 'Format', glyph: '%', needs: ['doc.write'],
        describe: 'Format as a percentage.',
        run: (a, ctx) => S(ctx).applyFormat(() => ({ numFmtId: BUILTIN_IDS.percentTwo })),
      })
      .define('fmt.comma', {
        title: 'Thousands', group: 'Format', glyph: ',', needs: ['doc.write'],
        describe: 'Group thousands with a comma.',
        run: (a, ctx) => S(ctx).applyFormat(() => ({ numFmtId: BUILTIN_IDS.commaTwo })),
      })
      .define('fmt.plain', {
        title: 'Plain number', group: 'Format', glyph: '0', needs: ['doc.write'],
        describe: 'Remove the number format.',
        run: (a, ctx) => S(ctx).applyFormat(() => ({ numFmtId: 0 })),
      })
      .define('fmt.fill', {
        title: 'Fill colour', group: 'Format', glyph: '▧', needs: ['doc.write'],
        undoable: false,   // the picker is asynchronous; fmt.fill.set does the write
        describe: 'Set the background colour of the selected cells.',
        run: (a, ctx) => pickColour('Fill', (c) => ctx.shell.run('fmt.fill.set', { hex: c || '' })),
      })
      .define('fmt.fill.set', {
        title: 'Set fill colour', group: 'Format', needs: ['doc.write'], args: { hex: 'Text' },
        describe: 'Set the background of the selected cells to a specific hex colour.',
        run: (a, ctx) => S(ctx).applyFormat(() => ({ fill: a.hex || null })),
      })
      .define('fmt.textcolor', {
        title: 'Text colour', group: 'Format', glyph: 'A', needs: ['doc.write'],
        undoable: false,
        describe: 'Set the text colour of the selected cells.',
        run: (a, ctx) => pickColour('Text', (c) => ctx.shell.run('fmt.textcolor.set', { hex: c || '' })),
      })
      .define('fmt.textcolor.set', {
        title: 'Set text colour', group: 'Format', needs: ['doc.write'], args: { hex: 'Text' },
        describe: 'Set the text of the selected cells to a specific hex colour.',
        run: (a, ctx) => S(ctx).applyFormat(() => ({ fontColor: a.hex || null })),
      })
      .define('fmt.border.all', {
        title: 'Borders', group: 'Format', glyph: '⊞', needs: ['doc.write'],
        describe: 'Put a thin border on every side of the selected cells.',
        run: (a, ctx) => S(ctx).applyFormat(() => ({ border: 'thin' })),
      })
      .define('fmt.border.none', {
        title: 'No borders', group: 'Format', glyph: '⊡', needs: ['doc.write'],
        describe: 'Remove borders from the selected cells.',
        run: (a, ctx) => S(ctx).applyFormat(() => ({ border: null })),
      })
      .define('fmt.size.up', {
        title: 'Bigger text', group: 'Format', glyph: 'A+', needs: ['doc.write'],
        describe: 'Increase the font size of the selected cells.',
        run: (a, ctx) => S(ctx).applyFormat((cur) => ({ fontSize: Math.min(72, (cur.size || 11) + 1) })),
      })
      .define('fmt.size.down', {
        title: 'Smaller text', group: 'Format', glyph: 'A-', needs: ['doc.write'],
        describe: 'Decrease the font size of the selected cells.',
        run: (a, ctx) => S(ctx).applyFormat((cur) => ({ fontSize: Math.max(6, (cur.size || 11) - 1) })),
      })
      .define('fmt.align.left', {
        title: 'Align left', group: 'Format', glyph: '⯇', needs: ['doc.write'],
        describe: 'Align the selected cells to the left.',
        run: (a, ctx) => S(ctx).applyFormat(() => ({ horizontal: 'left' })),
      })
      .define('fmt.align.center', {
        title: 'Align centre', group: 'Format', glyph: '≡', needs: ['doc.write'],
        describe: 'Centre the selected cells.',
        run: (a, ctx) => S(ctx).applyFormat(() => ({ horizontal: 'center' })),
      })
      .define('fmt.align.right', {
        title: 'Align right', group: 'Format', glyph: '⯈', needs: ['doc.write'],
        describe: 'Align the selected cells to the right.',
        run: (a, ctx) => S(ctx).applyFormat(() => ({ horizontal: 'right' })),
      })

      .define('data.sum', {
        title: 'Sum', group: 'Data', glyph: 'Σ', needs: ['doc.write'],
        describe: 'Insert a SUM formula totalling the selected cells, just below them.',
        run: (a, ctx) => {
          const grid = g(ctx);
          const r = grid.selRect();
          const target = { col: r.c0, row: r.r1 + 1 };
          const ref = `${indexToCol(r.c0)}${r.r0 + 1}:${indexToCol(r.c1)}${r.r1 + 1}`;
          ctx.doc.set(cellId(target.col, target.row, grid.sheet), `=SUM(${ref})`);
          grid.select(target.col, target.row);
        },
      })
      .define('data.fill.down', {
        title: 'Fill down', group: 'Data', glyph: '↓', key: 'Mod+D', needs: ['doc.write'],
        describe: 'Copy the top row of the selection into the rows below it, shifting relative references.',
        run: (a, ctx) => {
          const grid = g(ctx);
          const r = grid.selRect();
          for (let col = r.c0; col <= r.c1; col++) {
            const src = ctx.doc.raw(cellId(col, r.r0, grid.sheet));
            for (let row = r.r0 + 1; row <= r.r1; row++) {
              ctx.doc.set(cellId(col, row, grid.sheet), shiftRefs(src, row - r.r0));
            }
          }
        },
      })
      .define('data.sort', {
        title: 'Sort', group: 'Data', glyph: '⇅', needs: ['doc.write'],
        describe: 'Sort the selected rows ascending by their first column.',
        run: (a, ctx) => {
          const grid = g(ctx);
          const r = grid.selRect();
          const rows = [];
          for (let row = r.r0; row <= r.r1; row++) {
            const cells = [];
            for (let col = r.c0; col <= r.c1; col++) cells.push(ctx.doc.raw(cellId(col, row, grid.sheet)));
            rows.push({ key: ctx.doc.value(cellId(r.c0, row, grid.sheet)), cells });
          }
          rows.sort((x, y) => {
            const av = x.key, bv = y.key;
            if (av.k === 'number' && bv.k === 'number') return av.d.cmp(bv.d);
            return toText(av).localeCompare(toText(bv));
          });
          rows.forEach((rw, i) => {
            rw.cells.forEach((raw, j) => ctx.doc.set(cellId(r.c0 + j, r.r0 + i, grid.sheet), raw));
          });
        },
      })

      .define('sheet.insert.row', {
        title: 'Insert rows', group: 'Sheet', glyph: '⤒', needs: ['doc.write'],
        undoable: false,   // a journal cannot express a whole-document reshape
        describe: 'Insert rows above the selection. Formulas across the whole workbook follow.',
        run: (a, ctx) => S(ctx).structural('row', false),
      })
      .define('sheet.delete.row', {
        title: 'Delete rows', group: 'Sheet', glyph: '⌦', needs: ['doc.write'],
        undoable: false,
        describe: 'Delete the selected rows. References into them become #REF!, as they must.',
        run: (a, ctx) => S(ctx).structural('row', true),
      })
      .define('sheet.insert.col', {
        title: 'Insert columns', group: 'Sheet', glyph: '⇥', needs: ['doc.write'],
        undoable: false,
        describe: 'Insert columns to the left of the selection.',
        run: (a, ctx) => S(ctx).structural('col', false),
      })
      .define('sheet.delete.col', {
        title: 'Delete columns', group: 'Sheet', glyph: '⇤', needs: ['doc.write'],
        undoable: false,
        describe: 'Delete the selected columns.',
        run: (a, ctx) => S(ctx).structural('col', true),
      })
      .define('nav.goto', {
        title: 'Go to cell', group: 'View', glyph: '→', args: { cell: 'Text' },
        describe: 'Jump to a cell by its address, for example C42.',
        run: (a, ctx) => {
          const m = /^([A-Za-z]{1,3})(\d{1,7})$/.exec((a.cell || prompt('Go to cell (e.g. C42)') || '').trim());
          if (!m) return;
          let col = 0; for (const ch of m[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
          g(ctx).select(col - 1, parseInt(m[2], 10) - 1);
        },
      });
  },

  mount(host) {
    const doc = host.doc;

    /* ---- this pane's own DOM ---- */
    const fbar = document.createElement('div');
    fbar.className = 'sh-fbar';
    const addr = document.createElement('div');
    addr.className = 'sh-addr';
    addr.textContent = 'A1';
    const finput = document.createElement('input');
    finput.className = 'sh-finput';
    finput.spellcheck = false;
    finput.placeholder = 'Value or =formula';
    fbar.append(addr, finput);

    const wrap = document.createElement('div');
    wrap.className = 'sh-wrap';
    const canvas = document.createElement('canvas');
    canvas.className = 'sh-grid';
    canvas.setAttribute('tabindex', '0');
    const editor = document.createElement('input');
    editor.className = 'sh-editor';
    editor.spellcheck = false;
    wrap.append(canvas, editor);

    const tabs = document.createElement('div');
    tabs.className = 'sh-tabs';

    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.xlsx';
    fileInput.style.display = 'none';

    host.el.append(fbar, wrap, tabs, fileInput);

    /* ---- state ---- */
    let book = null;              // { wb, name, baseline, sheets, geom, stylesXml }
    let styleTable = null;
    let styleDirty = false;
    let editing = null;
    let message = '';
    let cutPending = null;
    let lastPayload = null;
    const structuralOps = [];
    const geomDirty = new Set();
    const resizedCols = new Map();
    const resizedRows = new Map();

    const say = (m) => { message = m; host.refresh(); };
    const styles = () => (styleTable || (styleTable = new StyleTable(book ? book.stylesXml : null)));

    const grid = new Grid(canvas, doc, {
      onResize: (axis, index, px) => {
        geomDirty.add(grid.sheet);
        const bag = axis === 'col' ? resizedCols : resizedRows;
        if (!bag.has(grid.sheet)) bag.set(grid.sheet, new Map());
        bag.get(grid.sheet).set(index, px);
        syncGeom();
        host.markDirty();
      },
      onSelect: () => syncBar(),
      onEdit: (sel, keepContent, seed) => beginEdit(sel, keepContent, seed),
    });

    /* ---- the cell editor ---- */
    function beginEdit(sel, keepContent, seed) {
      const id = cellId(sel.col, sel.row, grid.sheet);
      editing = { ...sel, id };
      editor.style.display = 'block';
      editor.style.left = grid.colX(sel.col) + 'px';
      editor.style.top = grid.rowY(sel.row) + 'px';
      editor.style.width = grid.width(sel.col) + 'px';
      editor.style.height = '26px';
      editor.value = seed !== undefined ? seed : (keepContent ? doc.raw(id) : '');
      editor.focus();
      if (seed === undefined) editor.setSelectionRange(editor.value.length, editor.value.length);
    }

    function commitEdit(move) {
      if (!editing) return;
      const { id, col, row } = editing;
      const val = editor.value;
      editor.style.display = 'none';
      editing = null;
      if (doc.raw(id) !== val) host.batch(() => doc.set(id, val));
      if (move === 'down') grid.select(col, row + 1);
      else if (move === 'right') grid.select(col + 1, row);
      else grid.draw();
      syncBar();
      canvas.focus();
    }

    editor.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commitEdit('down'); }
      else if (e.key === 'Tab') { e.preventDefault(); commitEdit('right'); }
      else if (e.key === 'Escape') {
        e.preventDefault();
        editor.style.display = 'none'; editing = null; canvas.focus(); grid.draw();
      }
      e.stopPropagation();
    });

    finput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const id = cellId(grid.sel.col, grid.sel.row, grid.sheet);
        if (doc.raw(id) !== finput.value) host.batch(() => doc.set(id, finput.value));
        grid.select(grid.sel.col, grid.sel.row + 1);
        syncBar();
        canvas.focus();
      } else if (e.key === 'Escape') { syncBar(); canvas.focus(); }
      e.stopPropagation();
    });

    function syncBar() {
      const s = grid.sel;
      const id = cellId(s.col, s.row, grid.sheet);
      addr.textContent = `${indexToCol(s.col)}${s.row + 1}`;
      if (document.activeElement !== finput) finput.value = doc.raw(id);
      host.shell.renderStatus();
    }

    /* ---- formatting ----------------------------------------------------
     * A cell holds an INDEX into the workbook's style table, not its
     * formatting. "Bold this" is "find or create an xf like this one but
     * bold, and point the cell at it" — and the new xf is APPENDED to
     * styles.xml by splicing, so the hundreds already in the file survive
     * byte-for-byte. */
    function applyFormat(fn) {
      const st = styles();
      const r = grid.selRect();
      let n = 0;
      for (let row = r.r0; row <= r.r1; row++) {
        for (let col = r.c0; col <= r.c1; col++) {
          const id = cellId(col, row, grid.sheet);
          const node = doc.node(id, true);
          const meta = { ...(node.meta || {}) };
          const base = meta.styleIndex === undefined ? 0 : meta.styleIndex;
          const cur = st.describe(base) || { bold: false, italic: false, numFmtId: 0, horizontal: null };
          const idx = st.derive(base, fn(cur));
          if (idx === base) continue;
          meta.styleIndex = idx;
          meta._styleChanged = true;
          applyResolvedStyle(meta, st.describe(idx));
          // Through the graph so the change reaches the undo journal. Assigning
          // node.meta directly is why bold used to be un-undoable.
          doc.setMeta(id, meta);
          n++;
        }
      }
      if (!n) { say('no change'); return; }
      styleDirty = true;
      say(`formatted ${n} cell${n === 1 ? '' : 's'}`);
    }

    /** Mirror an xf's properties into the meta the renderer reads. */
    function applyResolvedStyle(meta, d) {
      if (!d) return;
      const prev = meta.style || {};
      const thin = (st) => (st ? { style: st, color: '#000000' } : null);
      meta.style = {
        ...prev,
        font: { ...(prev.font || {}), bold: d.bold, italic: d.italic,
                size: d.size || 11, color: d.color || null },
        fill: d.fill ? { type: 'solid', color: d.fill } : null,
        border: d.border
          ? { left: thin(d.border.left), right: thin(d.border.right),
              top: thin(d.border.top), bottom: thin(d.border.bottom) }
          : null,
        align: { ...(prev.align || {}), h: d.horizontal },
      };
      meta.numFmtId = d.numFmtId;
      meta.numFmt = null;
      for (const [c, i] of styles().customFmts) if (i === d.numFmtId) meta.numFmt = c;
    }

    /* ---- structural edits ----------------------------------------------
     * Two things move, and forgetting either silently corrupts the file:
     *   1. the CELLS on the edited sheet shift, and
     *   2. every FORMULA in the WHOLE WORKBOOK pointing at that sheet has to
     *      follow — including formulas on other sheets, which is the part
     *      that is easy to miss because the edited sheet looks right after. */
    function structural(axis, remove) {
      const r = grid.selRect();
      const at = axis === 'row' ? r.r0 : r.c0;
      const count = axis === 'row' ? (r.r1 - r.r0 + 1) : (r.c1 - r.c0 + 1);
      const op = { sheet: grid.sheet, axis, at, count, remove };

      const before = doc.toJSON();
      const after = {};
      for (const [id, entry] of Object.entries(before)) {
        const i = id.indexOf('!');
        const sheetName = id.slice(0, i);
        const ref = id.slice(i + 1);
        const raw = typeof entry === 'string' ? entry : entry.r;
        const meta = typeof entry === 'string' ? null : entry.m;

        let nextRaw = raw;
        if (typeof raw === 'string' && raw.startsWith('=')) {
          nextRaw = '=' + adjustReferences(raw.slice(1), { ...op, homeSheet: sheetName });
        }
        let nextId = id;
        if (sheetName === op.sheet) {
          const m = /^([A-Za-z]{1,3})(\d+)$/.exec(ref);
          if (m) {
            let col = 0;
            for (const ch of m[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
            const moved = moveCell(col - 1, parseInt(m[2], 10) - 1, op);
            if (!moved) continue;                     // this cell was deleted
            nextId = cellId(moved.col, moved.row, sheetName);
          }
        }
        after[nextId] = meta ? { r: nextRaw, m: meta } : nextRaw;
      }

      doc.loadJSON(after);
      host.shell.undoStack.length = 0;
      host.shell.redoStack.length = 0;   // a journal cannot express this
      adjustGeometry(op);
      structuralOps.push(op);
      host.markDirty();
      say(`${remove ? 'deleted' : 'inserted'} ${count} ${axis}${count === 1 ? '' : 's'}`);
    }

    /** Merges, widths and heights shift with the cells they describe. */
    function adjustGeometry(op) {
      const gm = book && book.geom && book.geom.get(op.sheet);
      const shift = (i) => {
        if (op.remove) {
          if (i >= op.at && i < op.at + op.count) return null;
          return i >= op.at + op.count ? i - op.count : i;
        }
        return i >= op.at ? i + op.count : i;
      };
      const map = op.axis === 'col' ? grid.colW : grid.rowH;
      const next = new Map();
      for (const [i, v] of map) {
        if (i < 0) { next.set(i, v); continue; }       // the sheet default
        const n = shift(i);
        if (n !== null) next.set(n, v);
      }
      if (op.axis === 'col') grid.colW = next; else grid.rowH = next;

      const merges = [];
      for (const m of grid.merges) {
        const a = op.axis === 'row' ? shift(m.r0) : shift(m.c0);
        const b = op.axis === 'row' ? shift(m.r1) : shift(m.c1);
        if (a === null || b === null) continue;        // the merge was deleted
        merges.push(op.axis === 'row' ? { ...m, r0: a, r1: b } : { ...m, c0: a, c1: b });
      }
      grid.setMerges(merges);
      if (gm) { gm.merges = merges; gm.colWidths = grid.colW; gm.rowHeights = grid.rowH; }
      grid.invalidate();
    }

    function syncGeom() {
      const gm = book && book.geom && book.geom.get(grid.sheet);
      if (!gm) return;
      gm.colWidths = new Map(grid.colW);
      gm.rowHeights = new Map(grid.rowH);
    }

    /** Point the grid at a sheet and load THAT sheet's widths, heights,
     *  merges and charts. Geometry is per-sheet, not per-workbook. */
    function applySheetGeometry(name) {
      grid.sheet = name;
      const gm = book && book.geom && book.geom.get(name);
      grid.colW = gm ? new Map(gm.colWidths) : new Map();
      grid.rowH = gm ? new Map(gm.rowHeights) : new Map();
      grid.setMerges(gm ? gm.merges : []);
      grid.setCharts(gm ? gm.charts : []);
      grid.theme = book && book.wb && book.wb.styles ? book.wb.styles.theme : null;
      grid.invalidate();
    }

    function renderTabs() {
      if (!book) { tabs.style.display = 'none'; return; }
      tabs.style.display = 'flex';
      tabs.innerHTML = '';
      for (const sh of book.sheets) {
        const b = document.createElement('button');
        b.className = 'sh-tab' + (sh.name === grid.sheet ? ' on' : '');
        b.textContent = sh.name;
        b.onclick = () => {
          applySheetGeometry(sh.name);
          grid.scrollX = grid.scrollY = 0;
          grid.select(0, 0);
          renderTabs();
          grid.draw();
          syncBar();
        };
        tabs.appendChild(b);
      }
    }

    /* ---- .xlsx: open and save, with preserve-unknown --------------------
     * `book` holds the ORIGINAL archive for as long as the file is open. On
     * save we splice the cells that actually changed into the original sheet
     * XML and re-emit every other part from its original compressed bytes.
     * That is why a pivot table we cannot even display survives a save. */

    fileInput.addEventListener('change', async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      await openWorkbook(f);
      e.target.value = '';
    });

    async function openWorkbook(file) {
      say('reading…');
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const wb = await openXlsx(bytes);
        const worksheets = wb.sheets.filter((s) => s.path && s.kind === 'worksheet');
        if (!worksheets.length) { say('no worksheets in that file'); return; }

        const data = {};
        let cells = 0;
        const geom = new Map();
        for (const sh of worksheets) {
          const r = await readSheet(wb, sh);
          geom.set(sh.name, {
            colWidths: r.colWidths || new Map(),
            rowHeights: r.rowHeights || new Map(),
            merges: (r.merges || []).map(parseRangeRef).filter(Boolean),
            charts: await readSheetCharts(wb, sh),
          });
          for (const c of r.cells) {
            const id = `${sh.name}!${c.ref}`;
            let raw;
            // A DATE is a number wearing a date format. Keep it a number and
            // let the format render it — converting to an ISO string here
            // makes it text, and text does not do arithmetic.
            if (c.formula) raw = '=' + c.formula;
            else if (c.kind === 'text') raw = "'" + c.value;
            else if (c.kind === 'number') raw = c.value.toString();
            else if (c.kind === 'bool') raw = c.value ? 'TRUE' : 'FALSE';
            else if (c.kind === 'error') raw = c.value;
            else if (c.kind === 'date') raw = "'" + c.value;
            else raw = '';
            data[id] = (c.style || c.numFmt || c.numFmtId || c.styleIndex !== undefined)
              ? { r: raw, m: { style: c.style || null, numFmt: c.numFmt || null,
                               numFmtId: c.numFmtId || 0, date1904: wb.date1904,
                               styleIndex: c.styleIndex === undefined ? 0 : +c.styleIndex } }
              : raw;
            cells++;
          }
        }

        doc.loadJSON(data);
        host.shell.undoStack.length = 0;
        host.shell.redoStack.length = 0;

        book = { wb, name: file.name, sheets: worksheets, geom,
                 baseline: JSON.stringify(doc.toJSON()),
                 stylesXml: await wb.zip.text(wb.stylesPath) };
        styleTable = null;                 // rebuilt from THIS workbook's styles
        styleDirty = false;

        // THIS file is now the document. Autosaving a copy of a 40MB workbook
        // into localStorage is both wrong and impossible.
        host.shell.setAutosave(false);
        host.shell.docName = file.name.replace(/\.xlsx$/i, '');
        if (host.shell.nameInput) host.shell.nameInput.value = host.shell.docName;

        applySheetGeometry(worksheets[0].name);
        grid.select(0, 0);
        renderTabs();
        grid.draw();
        syncBar();

        const unmodelled = wb.unmodelledParts().length;
        let chartCount = 0;
        for (const gm of geom.values()) chartCount += (gm.charts || []).length;
        say(`${cells.toLocaleString()} cells · ${worksheets.length} sheet${worksheets.length > 1 ? 's' : ''} · ` +
            `${unmodelled} parts kept untouched` +
            (chartCount ? ` · ${chartCount} chart${chartCount > 1 ? 's' : ''}` : '') +
            (wb.warnings.length ? ` · ${wb.warnings.length} warnings` : ''));
      } catch (ex) {
        console.error(ex);
        say('could not open: ' + ex.message);
      }
    }

    async function saveXlsx() {
      if (!book) { say('open an .xlsx first — a new sheet has no original to preserve'); return; }
      say('writing…');
      try {
        // Only cells whose RAW INPUT differs from what we read are written
        // back. Computed values are never written: a cached value that
        // disagrees with its formula is the most corrosive bug a spreadsheet
        // can carry. A structural edit is applied to the sheet's SKELETON,
        // once, before any cell diffing — otherwise inserting one row into a
        // 3,000-cell sheet becomes 3,000 splices, which never finishes.
        const structuralXml = new Map();
        if (structuralOps.length) {
          for (const op of structuralOps) {
            const sh = book.sheets.find((x) => x.name === op.sheet);
            if (!sh) continue;
            const cur = structuralXml.get(sh.path) || await book.wb.zip.text(sh.path);
            structuralXml.set(sh.path, applyStructural(cur, op));
          }
          book.baseline = JSON.stringify(doc.toJSON());
        }

        const base = JSON.parse(book.baseline);
        const now = doc.toJSON();
        const changedBySheet = new Map();
        const keys = new Set([...Object.keys(base), ...Object.keys(now)]);
        let changes = 0;
        for (const k of keys) {
          const a = typeof base[k] === 'string' ? base[k] : (base[k] ? base[k].r : '');
          const b = typeof now[k] === 'string' ? now[k] : (now[k] ? now[k].r : '');
          if (a === b) continue;
          const i = k.indexOf('!');
          const sheetName = k.slice(0, i), ref = k.slice(i + 1);
          if (!changedBySheet.has(sheetName)) changedBySheet.set(sheetName, []);
          changedBySheet.get(sheetName).push({ ref, raw: b });
          changes++;
        }

        const parts = new Map();

        // Cells whose STYLE changed need their s= attribute rewritten, and any
        // new xfs need to reach styles.xml.
        const styledBySheet = new Map();
        if (styleDirty) {
          for (const [id, node] of doc.nodes) {
            if (!node.meta || node.meta.styleIndex === undefined || !node.meta._styleChanged) continue;
            const i = id.indexOf('!');
            const sn = id.slice(0, i);
            if (!styledBySheet.has(sn)) styledBySheet.set(sn, []);
            styledBySheet.get(sn).push({ ref: id.slice(i + 1), idx: node.meta.styleIndex });
          }
          const newStyles = styles().serialize();
          if (newStyles) parts.set(book.wb.stylesPath, newStyles);
        }

        for (const [sheetName, edits] of changedBySheet) {
          const sh = book.sheets.find((s) => s.name === sheetName);
          if (!sh) continue;
          let xml = structuralXml.get(sh.path) || await book.wb.zip.text(sh.path);
          structuralXml.delete(sh.path);
          for (const ed of edits) {
            const { inner, type } = cellInner(ed.raw.startsWith("'") ? ed.raw.slice(1) : ed.raw);
            xml = setCellRaw(xml, ed.ref, inner, type);
          }
          for (const sd of (styledBySheet.get(sheetName) || [])) xml = setCellStyle(xml, sd.ref, sd.idx);
          styledBySheet.delete(sheetName);
          parts.set(sh.path, xml);
        }

        // sheets with style changes but no value changes
        for (const [sheetName, list] of styledBySheet) {
          const sh = book.sheets.find((x) => x.name === sheetName);
          if (!sh) continue;
          let xml = structuralXml.get(sh.path) || await book.wb.zip.text(sh.path);
          structuralXml.delete(sh.path);
          for (const sd of list) xml = setCellStyle(xml, sd.ref, sd.idx);
          parts.set(sh.path, xml);
        }

        // sheets changed ONLY structurally
        for (const [path, xml] of structuralXml) parts.set(path, xml);

        // Column widths and row heights. A resize that is not written back is
        // a change the user made and the file forgot.
        for (const sheetName of geomDirty) {
          const sh = book.sheets.find((x) => x.name === sheetName);
          if (!sh) continue;
          if (!book.geom.get(sheetName)) continue;
          let xml = parts.get(sh.path) || await book.wb.zip.text(sh.path);
          // Only the columns and rows the user actually dragged. Writing all
          // of them would re-round every untouched one.
          xml = setColumnWidths(xml, resizedCols.get(sheetName) || new Map());
          xml = setRowHeights(xml, resizedRows.get(sheetName) || new Map());
          parts.set(sh.path, xml);
        }

        const out = await writeZip(book.wb.zip, parts);
        const blob = new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = (host.shell.docName || 'workbook') + '.xlsx';
        a.click();
        URL.revokeObjectURL(a.href);

        const untouched = book.wb.zip.entries.length - parts.size;
        // Report style changes too. "0 cells changed" after formatting 35
        // cells reads as a failed save.
        let styled = 0;
        for (const node of doc.nodes.values()) if (node.meta && node.meta._styleChanged) styled++;
        const what = [
          changes ? `${changes} value${changes === 1 ? '' : 's'}` : null,
          styled ? `${styled} format${styled === 1 ? '' : 's'}` : null,
          structuralOps.length ? `${structuralOps.length} row/column edit${structuralOps.length === 1 ? '' : 's'}` : null,
          geomDirty.size ? 'resized' : null,
        ].filter(Boolean).join(' · ') || 'no changes';
        structuralOps.length = 0;
        geomDirty.clear(); resizedCols.clear(); resizedRows.clear();
        say(`saved · ${what} · ${untouched} parts re-emitted byte-for-byte`);
      } catch (ex) {
        console.error(ex);
        say('could not save: ' + ex.message);
      }
    }

    function exportCsv() {
      let maxC = 0, maxR = 0;
      for (const id of doc.nodes.keys()) {
        const m = /!([A-Z]+)(\d+)$/.exec(id);
        if (!m) continue;
        let c = 0; for (const ch of m[1]) c = c * 26 + (ch.charCodeAt(0) - 64);
        maxC = Math.max(maxC, c); maxR = Math.max(maxR, parseInt(m[2], 10));
      }
      const lines = [];
      for (let r = 0; r < maxR; r++) {
        const row = [];
        for (let c = 0; c < maxC; c++) {
          const t = toText(doc.value(cellId(c, r, grid.sheet)));
          row.push(/[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t);
        }
        lines.push(row.join(','));
      }
      const blob = new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = (host.shell.docName || 'sheet') + '.csv';
      a.click();
      URL.revokeObjectURL(a.href);
    }

    /* ---- clipboard ------------------------------------------------------
     * Bound to the browser's own copy/cut/paste EVENTS. navigator.clipboard
     * needs a permission prompt and a user gesture; the events need neither
     * and fire from the keystrokes the user already knows. */

    function selectionPayload() {
      const r = grid.selRect();
      return buildPayload(
        r,
        (c, row) => doc.raw(cellId(c, row, grid.sheet)),
        (c, row) => {
          const v = doc.value(cellId(c, row, grid.sheet));
          return v.k === 'number' ? v.d.toString() : toText(v);
        },
      );
    }

    function doCopy(isCut) {
      lastPayload = selectionPayload();
      cutPending = isCut ? { ...grid.selRect(), sheet: grid.sheet } : null;
      // execCommand routes through the copy handler below, so the two
      // payloads are written exactly once, in one place.
      try { document.execCommand(isCut ? 'cut' : 'copy'); } catch { /* ignore */ }
      const r = grid.selRect();
      const cells = (r.c1 - r.c0 + 1) * (r.r1 - r.r0 + 1);
      say((isCut ? 'cut ' : 'copied ') + (cells === 1 ? '1 cell' : `${cells} cells`));
    }

    const isTextInput = (n) => n && (n.tagName === 'INPUT' || n.tagName === 'TEXTAREA');
    const writeClip = (e) => {
      if (editing || isTextInput(document.activeElement)) return;
      const p = lastPayload || selectionPayload();
      e.clipboardData.setData('text/plain', p.tsv);
      e.clipboardData.setData(MIME, p.grain);
      e.preventDefault();
    };
    const readClip = (e) => {
      if (editing || isTextInput(document.activeElement)) return;
      e.preventDefault();
      applyPaste({ grain: e.clipboardData.getData(MIME), tsv: e.clipboardData.getData('text/plain') });
    };
    // Named, so teardown() can take them off again. These are on `document`,
    // not on our canvas, because the browser only fires clipboard events at
    // the document — which also means a forgotten surface keeps listening.
    document.addEventListener('copy', writeClip);
    document.addEventListener('cut', writeClip);
    document.addEventListener('paste', readClip);

    function applyPaste(clip) {
      const target = { col: grid.sel.col, row: grid.sel.row };
      const cells = decodePaste(clip, target);
      if (!cells || !cells.length) { say('nothing to paste'); return; }
      let n = 0;
      host.batch(() => {
        // A cut only takes effect when it is pasted — matching every
        // spreadsheet, and meaning an abandoned cut destroys nothing.
        if (cutPending) {
          for (let r = cutPending.r0; r <= cutPending.r1; r++)
            for (let c = cutPending.c0; c <= cutPending.c1; c++)
              doc.set(cellId(c, r, cutPending.sheet), '');
          cutPending = null;
        }
        for (let r = 0; r < cells.length; r++) {
          for (let c = 0; c < cells[r].length; c++) {
            const raw = cells[r][c];
            doc.set(cellId(target.col + c, target.row + r, grid.sheet), raw === undefined ? '' : raw);
            n++;
          }
        }
      });
      grid.anchor = { col: target.col, row: target.row };
      grid.sel = { col: target.col + cells[0].length - 1, row: target.row + cells.length - 1 };
      syncBar();
      say(`pasted ${n} cell${n === 1 ? '' : 's'}`);
    }

    /* Resolve a chart's series reference against the LIVE graph. Returning
     * the graph's values rather than the file's cached ones is what makes a
     * chart move when you edit a cell; every other reader shows you what the
     * workbook said the last time it was saved. */
    grid.resolveRef = (f) => {
      const parts = splitRef(f);
      if (!parts) return null;
      const sheetName = parts.sheet || grid.sheet;
      const rect = parseRangeRef(parts.ref) || parseRangeRef(parts.ref + ':' + parts.ref);
      if (!rect) return null;
      const span = (rect.c1 - rect.c0 + 1) * (rect.r1 - rect.r0 + 1);
      if (span > 20000) return null;          // a runaway ref is not data
      const out = [];
      for (let r = rect.r0; r <= rect.r1; r++)
        for (let c = rect.c0; c <= rect.c1; c++) {
          const v = doc.value(cellId(c, r, sheetName));
          out.push(v.k === 'number' ? v.d.toNumber() : v.k === 'text' ? v.s : null);
        }
      return out;
    };

    renderTabs();

    return {
      grid, fileInput, say, applyFormat, structural, saveXlsx, exportCsv, openWorkbook,
      get book() { return book; },
      // exposed so a test can paste without going through the OS clipboard
      applyPaste,

      draw() { grid.draw(); },
      /** Give back everything this surface registered outside its own pane. */
      teardown() {
        document.removeEventListener('copy', writeClip);
        document.removeEventListener('cut', writeClip);
        document.removeEventListener('paste', readClip);
        grid.dispose();
      },
      // The shell calls this whenever the pane changes size — see its
      // ResizeObserver. A canvas cannot work this out for itself.
      resize() { grid.resize(); },
      focus() { canvas.focus(); },
      capturing() { return editing !== null || document.activeElement === finput; },
      clipboard(kind) { doCopy(kind === 'cut'); },
      reset() {
        book = null; styleTable = null; styleDirty = false;
        structuralOps.length = 0; geomDirty.clear();
        resizedCols.clear(); resizedRows.clear();
        grid.colW = new Map(); grid.rowH = new Map();
        grid.setMerges([]); grid.setCharts([]);
        grid.sheet = SHEET;
        grid.invalidate();
        host.shell.setAutosave(true);
        renderTabs();
        message = '';
        syncBar();
      },
      handleKey(e) {
        if (grid.handleKey(e)) { syncBar(); return true; }
        return false;
      },
      status() {
        const s = grid.sel;
        const r = grid.selRect();
        const out = [`<b>${indexToCol(s.col)}${s.row + 1}</b>`];
        const nums = [];
        let filled = 0;
        for (let row = r.r0; row <= r.r1; row++) {
          for (let col = r.c0; col <= r.c1; col++) {
            const v = doc.value(cellId(col, row, grid.sheet));
            if (!isBlank(v)) filled++;
            if (v.k === 'number') nums.push(v.d);
          }
        }
        if (nums.length) {
          const sum = nums.reduce((a, b) => a.add(b), Decimal.zero());
          const avg = sum.div(new Decimal(BigInt(nums.length), 0));
          out.push(`Sum <b>${groupDigits(sum)}</b> &nbsp; Average <b>${groupDigits(avg.round(6))}</b> &nbsp; Count <b>${nums.length}</b>`);
        }
        const cells = (r.c1 - r.c0 + 1) * (r.r1 - r.r0 + 1);
        if (cells > 1) out.push(`${cells} cells, ${filled} filled`);
        if (message) out.push(message);
        return out;
      },
    };
  },
};

export { makeGraph, cellId, expand, SHEET, COLS, ROWS };
