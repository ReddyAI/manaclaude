import { describe, expect, it } from 'vitest';
import { parseCsvWithMapping, suggestCsvMapping, type DateFormat } from '../src';

// Invented statement rows only.
const csv = (dates: string[]) =>
  ['Date,Description,Amount', ...dates.map((date) => `"${date}",Orchard books,-12.50`)].join('\n');

describe('CSV date evidence', () => {
  it.each<[DateFormat, string]>([
    ['YYYY-MM-DD', '2026-11-23'],
    ['YYYY/MM/DD', '2026/11/23'],
    ['YYYYMMDD', '20261123'],
    ['MM/DD/YYYY', '11/23/2026'],
    ['DD/MM/YYYY', '23/11/2026'],
    ['MM-DD-YYYY', '11-23-2026'],
    ['DD-MM-YYYY', '23-11-2026'],
    ['DD.MM.YYYY', '23.11.2026'],
    ['MM/DD/YY', '11/23/26'],
    ['DD/MM/YY', '23/11/26'],
    ['DD-MMM-YYYY', '23-Nov-2026'],
    ['DD MMM YYYY', '23 Nov 2026'],
    ['MMM DD, YYYY', 'Nov 23, 2026'],
    ['DD-MMM-YY', '23-Nov-26'],
  ])('detects %s despite an unreadable cell, without losing either purchase', (format, date) => {
    const text = csv([date, 'unreadable', date]);
    const suggestion = suggestCsvMapping(text);
    expect(suggestion.missing).toEqual([]);
    expect(suggestion.mapping.dateFormat).toBe(format);
    expect(suggestion.dateFormatCandidates).toEqual([format]);
    expect(suggestion.dateFormatAmbiguous).toBe(false);
    const parsed = parseCsvWithMapping(text, suggestion.mapping, 'USD');
    expect(parsed.rows.map((row) => [row.line, row.date, row.amount])).toEqual([
      [2, '2026-11-23', -1250],
      [4, '2026-11-23', -1250],
    ]);
    expect(parsed.errors).toEqual([
      { line: 3, message: `Can't read the date "unreadable" as ${format}.` },
    ]);
  });

  it.each(['31/02/2026', 'Statement total', ''])(
    'reports invalid date %j as a line error',
    (bad) => {
      const text = csv(['23/11/2026', '24/11/2026', bad]);
      const suggestion = suggestCsvMapping(text);
      expect(suggestion.missing).toEqual([]);
      expect(suggestion.mapping.dateFormat).toBe('DD/MM/YYYY');
      const parsed = parseCsvWithMapping(text, suggestion.mapping, 'USD');
      expect(parsed.rows.map((row) => row.line)).toEqual([2, 3]);
      expect(parsed.errors).toEqual([
        { line: 4, message: `Can't read the date "${bad}" as DD/MM/YYYY.` },
      ]);
    },
  );

  it.each([undefined, false, true])(
    'preserves ambiguity with preferDayFirst=%s',
    (preferDayFirst) => {
      const text = csv(['03/04/2026', 'unreadable', '05/06/2026']);
      const suggestion = suggestCsvMapping(text, { preferDayFirst });
      expect(suggestion.missing).toEqual([]);
      expect(suggestion.dateFormatCandidates).toEqual(['MM/DD/YYYY', 'DD/MM/YYYY']);
      expect(suggestion.dateFormatAmbiguous).toBe(true);
      expect(suggestion.mapping.dateFormat).toBe(preferDayFirst ? 'DD/MM/YYYY' : 'MM/DD/YYYY');
      expect(suggestion).toEqual(
        suggestCsvMapping(csv(['03/04/2026', '05/06/2026']), { preferDayFirst }),
      );
    },
  );

  it('does not call equivalent day/month interpretations ambiguous', () => {
    const suggestion = suggestCsvMapping(csv(['04/04/2026', 'unreadable']));
    expect(suggestion.dateFormatCandidates).toEqual(['MM/DD/YYYY', 'DD/MM/YYYY']);
    expect(suggestion.dateFormatAmbiguous).toBe(false);
  });

  it.each([
    [],
    [''],
    ['unreadable', '31/02/2026', 'Statement total'],
    ['2026-11-23', '23/11/2026', 'unreadable'],
    ['23/11/2026', '11/24/2026', 'unreadable'],
  ])('requires manual mapping when evidence has no common format: %j', (...dates) => {
    const suggestion = suggestCsvMapping(csv(dates));
    expect(suggestion.missing).toEqual(['date']);
    expect(suggestion.dateFormatCandidates).toEqual([]);
    expect(suggestion.dateFormatAmbiguous).toBe(false);
  });

  it('requires a date column and does not guess from another column', () => {
    const suggestion = suggestCsvMapping('Description,Amount\n2026-11-23,-12.50');
    expect(suggestion.missing).toEqual(['date']);
    expect(suggestion.dateFormatCandidates).toEqual([]);
  });

  it('keeps the existing bounded sample when it has no usable date evidence', () => {
    const suggestion = suggestCsvMapping(
      csv([...Array<string>(199).fill('unreadable'), '2026-11-23']),
    );
    expect(suggestion.missing).toEqual(['date']);
    expect(suggestion.dateFormatCandidates).toEqual([]);
  });

  it('keeps explicit parsing strict even when another format reads the date', () => {
    const text = csv(['23/11/2026', '2026-11-24', 'unreadable']);
    const mapping = { ...suggestCsvMapping(text).mapping, dateFormat: 'YYYY-MM-DD' as const };
    const parsed = parseCsvWithMapping(text, mapping, 'USD');
    expect(parsed.rows.map((row) => [row.line, row.date])).toEqual([[3, '2026-11-24']]);
    expect(parsed.errors).toEqual([
      { line: 2, message: 'Can\'t read the date "23/11/2026" as YYYY-MM-DD.' },
      { line: 4, message: 'Can\'t read the date "unreadable" as YYYY-MM-DD.' },
    ]);
  });
});
