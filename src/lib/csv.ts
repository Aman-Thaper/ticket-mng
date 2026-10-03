/*
 * CSV for spreadsheets: what an organizer downloads to open in Excel or Google Sheets.
 *
 * Two kinds of escaping:
 *   1. RFC 4180: a cell holding a comma, quote or line break is wrapped in quotes, and its
 *      quotes are doubled.
 *   2. Formula injection (CSV injection): spreadsheets run a cell starting with = + - @ (or a
 *      tab or carriage return) as a formula. Attendee names are typed by the public, so
 *      "=HYPERLINK(\"https://evil.example\",\"Click\")" as a name would become a live link,
 *      or worse, in the organizer's spreadsheet. Such cells get a leading apostrophe, which
 *      spreadsheets read as "this is text" (OWASP's recommendation).
 */

const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  if (typeof value === 'string' && FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One CSV line, CRLF-terminated as RFC 4180 asks. */
export const csvRow = (values: (string | number | null | undefined)[]) =>
  `${values.map(csvCell).join(',')}\r\n`;

/** A byte-order mark: without it, Excel reads UTF-8 files as Windows-1252 and garbles accents. */
export const CSV_BOM = '\uFEFF';
