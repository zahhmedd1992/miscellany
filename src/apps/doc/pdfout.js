/* Doc -> PDF.
 *
 * There is almost nothing in this file, and that is the claim it exists to
 * make. Exporting a PDF is not a second rendering of the document; it is the
 * SAME drawPage() the screen calls, handed a context that writes PDF
 * operators instead of pixels.
 *
 * So the things that normally differ between a screen and a printout cannot:
 *   - line breaks, because layout used the widths the PDF declares
 *   - alignment and justification, because they were computed once
 *   - charts, because chartview.js draws them through the same context
 *   - page breaks, because the page WAS the unit the document was laid out in
 *
 * The one deliberate difference: the pale tint behind a live figure is a
 * screen affordance, not part of the document, so it is not printed. The
 * number is.
 */

import { PdfCanvas, FontRegistry } from '../../core/pdf/canvas.js';
import { buildDocument } from '../../core/pdf/make.js';
import { drawPage } from '../../core/text/render.js';

/**
 * Render a DocView's pages to PDF bytes.
 * Pure: it reads the view, and touches neither the document nor the DOM.
 */
export function renderPdf(view, meta = {}) {
  const reg = new FontRegistry();
  const box = view.box;
  const out = [];
  for (const page of view.pages) {
    const ctx = new PdfCanvas(box.w, box.h, reg);
    drawPage(ctx, page, {
      fieldTint: false,
      images: view.images,
      chart: (c, item) => view.paintChart(c, item),
    });
    out.push({
      w: box.w, h: box.h,
      content: ctx.content(),
      images: ctx.images,
      gstates: ctx.gstates(),
      // every font this page used, as [base name, resource name]
      fonts: reg.names(),
    });
  }
  /* The registry is shared, so a font first used on page 9 is still in page
   * 1's resource dictionary. Harmless, and cheaper than a second pass. */
  return buildDocument(out, meta);
}

/** Render and hand the file to the browser. Returns what to tell the user. */
export function exportPdf(view, name, openInstead) {
  const bytes = renderPdf(view, { title: name, subject: 'Made with Miscellany Doc' });
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  if (openInstead) {
    /* Printing goes through the PDF too, rather than through the browser's
     * own print of a canvas: a printed canvas is a picture of the document at
     * screen resolution, with no selectable text and visibly soft type. */
    const w = window.open(url, '_blank');
    if (w) setTimeout(() => { try { w.print(); } catch { /* the viewer will do */ } }, 800);
  } else {
    const a = document.createElement('a');
    a.href = url;
    a.download = (name || 'document') + '.pdf';
    a.click();
  }
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  return { pages: view.pages.length, bytes: bytes.length };
}
