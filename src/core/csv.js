/**
 * The one CSV dialect this script reads and writes: RFC 4180, UTF-8, CRLF
 * between rows. Used both for the file the user exports and for what the
 * userscript manager keeps on disk, so a value written into storage can be
 * read by the same parser as a hand-edited file.
 */

const NEEDS_QUOTING = /[",\r\n]|^\s|\s$/u;
/**
 * A cell a spreadsheet would evaluate: Excel treats a leading `=`, `+`, `-`,
 * `@`, tab or CR as the start of a formula, and the book's text comes from
 * whatever page the user was reading.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/u;

/** One cell: quote only when the text would otherwise break the grid. */
export function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return NEEDS_QUOTING.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

/**
 * Prefix a cell a spreadsheet would run as a formula with an apostrophe, the
 * standard way to make it literal text. Only the file written for a human goes
 * through this; storage is read by this script alone and keeps its values raw.
 */
export function formulaSafeCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return FORMULA_LEAD.test(text) ? `'${text}` : text;
}

/** Undo `formulaSafeCell`, so a guarded file round-trips to the same values. */
export function unguardCell(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return text.startsWith("'") && FORMULA_LEAD.test(text.slice(1)) ? text.slice(1) : text;
}

/**
 * `columns` is the header row; `rows` are arrays of cell values in that order.
 * The BOM is for files opened in a spreadsheet — an Excel on a Windows code
 * page reads a BOM-less UTF-8 file as mojibake. Storage never needs it.
 * `formulaSafe` guards every cell against being run as a formula.
 */
export function encodeCsv(columns, rows, { bom = false, formulaSafe = false } = {}) {
  // Guard before quoting: a quoted `"=1,2"` is still evaluated by Excel once
  // the CSV layer is stripped, so the apostrophe has to be inside the quotes.
  const cell = formulaSafe ? (value) => csvCell(formulaSafeCell(value)) : csvCell;
  const lines = [columns.map(cell).join(',')];
  for (const row of rows) lines.push(row.map(cell).join(','));
  return `${bom ? '\uFEFF' : ''}${lines.join('\r\n')}`;
}

/**
 * Read RFC 4180 text into rows of cells. Quoted cells may hold commas, quotes
 * and line breaks. A stray quote inside an unquoted cell stays literal; an
 * unclosed quote throws, because guessing would silently corrupt the result.
 * Blank lines, including the one a trailing newline leaves behind, are dropped.
 */
export function decodeCsv(source) {
  const text = String(source ?? '').replace(/^\uFEFF/u, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char !== '"') {
        cell += char;
      } else if (text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else {
        quoted = false;
      }
      continue;
    }
    if (char === '"' && cell === '') {
      quoted = true;
    } else if (char === ',') {
      row.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += char;
    }
  }
  if (quoted) throw new Error('不是有效的 CSV:引号没有闭合');
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  // A line of nothing but commas is a row of empty cells, not a blank line:
  // dropping it would make a malformed row vanish without being counted.
  return rows.filter((cells) => cells.length > 1 || cells[0].trim() !== '');
}
