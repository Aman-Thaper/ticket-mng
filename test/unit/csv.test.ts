import { describe, expect, it } from 'vitest';
import { csvCell, csvRow } from '../../src/lib/csv.js';

describe('CSV', () => {
  it('leaves plain values alone', () => {
    expect(csvRow(['Ada Lovelace', 'ada@example.com', 42, null])).toBe(
      'Ada Lovelace,ada@example.com,42,\r\n',
    );
  });

  it('quotes commas, quotes and line breaks (RFC 4180)', () => {
    expect(csvCell('Lovelace, Ada')).toBe('"Lovelace, Ada"');
    expect(csvCell('The "Countess"')).toBe('"The ""Countess"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
  });

  it('defuses cells a spreadsheet would run as a formula', () => {
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('+44 20 7946 0000')).toBe("'+44 20 7946 0000");
    expect(csvCell('-2')).toBe("'-2");
    expect(csvCell('@SUM(A1:A9)')).toBe("'@SUM(A1:A9)");
    expect(csvCell('\tcmd')).toBe("'\tcmd");
    // Escaped and then quoted, when both apply.
    expect(csvCell('=HYPERLINK("https://evil.example","Click")')).toBe(
      '"\'=HYPERLINK(""https://evil.example"",""Click"")"',
    );
  });

  it('keeps real numbers as numbers, negatives included', () => {
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell(1999)).toBe('1999');
  });
});
