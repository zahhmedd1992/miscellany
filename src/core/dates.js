/* Grain — spreadsheet date serials.
 *
 * Pure arithmetic over a day count. It lives in core/ rather than in the
 * OOXML reader because DISPLAY needs it: making the number-format engine
 * import the file parser would mean loading the whole .xlsx stack just to
 * render a date, and Deck would inherit that for no reason.
 */

/* ---- serial dates ------------------------------------------------------ */

/** Excel serial -> ISO date string. Handles both epochs and the phantom
 *  1900-02-29: Excel models 1900 as a leap year to stay bug-compatible with
 *  Lotus 1-2-3, so serial 60 is a day that never existed. We map it and every
 *  earlier serial correctly rather than inheriting the off-by-one. */
export function serialToISO(serial, date1904) {
  let d = Number(serial);
  if (!Number.isFinite(d)) return null;
  const epoch = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 31);
  let days = Math.floor(d);
  const frac = d - days;
  if (!date1904) {
    if (days === 60) return '1900-02-29(invalid)';   // the phantom day, surfaced not hidden
    if (days > 60) days -= 1;
  }
  const ms = epoch + days * 86400000 + Math.round(frac * 86400000);
  const dt = new Date(ms);
  if (Number.isNaN(dt.getTime())) return null;
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const iso = `${p(dt.getUTCFullYear(), 4)}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
  if (frac === 0) return iso;
  return `${iso} ${p(dt.getUTCHours())}:${p(dt.getUTCMinutes())}:${p(dt.getUTCSeconds())}`;
}
