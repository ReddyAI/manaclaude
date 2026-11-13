import {
  excerpt,
  fileState,
  findStoredFile,
  formatLabel,
  importsOf,
  isTextFile,
  mimeOf,
  safeFileName,
  sizeLabel,
  storedFiles,
} from '../vaultFiles';
import { importSentence } from '../labels';
import { LISTED, stored } from './fixtures';

describe('stored files', () => {
  it('makes one file of the copies that hold the same bytes, newest file first', () => {
    const files = storedFiles(LISTED);
    expect(files.map((f) => f.record.fileName)).toEqual([
      'wallet.qif',
      'october.csv',
      'nro-september.pdf',
    ]);
    expect(files.map((f) => f.copies.length)).toEqual([1, 3, 1]);
  });

  it('shows a file by its most telling copy: a saved import before a preview', () => {
    const october = storedFiles(LISTED)[1]!;
    expect(october.id).toBe('imp_4');
    expect(fileState(october.record)).toBe('imported');
    expect(october.copies.map((c) => c.id)).toEqual(['imp_5', 'imp_4', 'imp_3']);
    // Undone ranks below saved and above a preview; a save under way above undone.
    const mixed = storedFiles([
      stored('a', { status: 'preview' }),
      stored('b', { status: 'undone' }),
      stored('c', { status: 'failed' }),
    ])[0]!;
    expect(mixed.id).toBe('b');
    expect(
      storedFiles([stored('a', { status: 'undone' }), stored('b', { status: 'committing' })])[0]!
        .id,
    ).toBe('b');
  });

  it('finds a file by the id of any of its copies', () => {
    const files = storedFiles(LISTED);
    expect(findStoredFile(files, 'imp_3')?.id).toBe('imp_4');
    expect(findStoredFile(files, 'imp_2')?.id).toBe('imp_2');
    expect(findStoredFile(files, 'imp_unknown')).toBeNull();
  });

  it('keeps records without a hash apart', () => {
    expect(storedFiles([stored('a', { sha256: '' }), stored('b', { sha256: '' })])).toHaveLength(2);
  });

  it('lists the imports of a file, not its bare previews', () => {
    const [wallet, october] = storedFiles(LISTED);
    expect(importsOf(october!).map((r) => r.id)).toEqual(['imp_4']);
    expect(importsOf(wallet!)).toEqual([]);
    expect(fileState(wallet!.record)).toBe('not_imported');
  });

  it('says what each import did', () => {
    expect(importSentence(stored('a'))).toBe('2026-11-03: 12 added, 2 already there, 0 left out.');
    expect(importSentence(stored('a', { status: 'undone' }))).toBe(
      '2026-11-03: 12 added, then removed by undo.',
    );
    expect(importSentence(stored('a', { status: 'failed', committedAt: null }))).toBe(
      '2026-11-03: the file could not be read.',
    );
  });
});

describe('file details', () => {
  it('labels kinds and sizes', () => {
    expect(['csv', 'pdf', 'ofx', 'qif', 'xyz'].map(formatLabel)).toEqual([
      'CSV',
      'PDF',
      'OFX',
      'QIF',
      'XYZ',
    ]);
    expect([1, 840, 12_400, 1_500_000].map(sizeLabel)).toEqual([
      '1 byte',
      '840 bytes',
      '12 KB',
      '1.4 MB',
    ]);
  });

  it('reads text files on screen and never a PDF', () => {
    expect(isTextFile(stored('a'))).toBe(true);
    expect(isTextFile(stored('a', { format: 'pdf', contentType: 'application/pdf' }))).toBe(false);
    expect(isTextFile(stored('a', { format: 'csv', contentType: 'application/pdf' }))).toBe(false);
  });

  it('names the type for another app', () => {
    expect(mimeOf(stored('a', { format: 'pdf', contentType: '' }))).toBe('application/pdf');
    expect(mimeOf(stored('a', { contentType: 'text/csv; charset=utf-8' }))).toBe('text/csv');
    expect(mimeOf(stored('a', { contentType: 'application/octet-stream' }))).toBe('text/csv');
    expect(mimeOf(stored('a', { contentType: '', fileName: 'x.qif', format: 'qif' }))).toBe(
      'text/plain',
    );
  });

  it('makes a file name safe as one path part', () => {
    expect(safeFileName('../../etc/My statement (Oct).csv')).toBe('My_statement_Oct_.csv');
    expect(safeFileName('C:\\Users\\me\\..hidden.qif')).toBe('hidden.qif');
    expect(safeFileName('...')).toBe('statement');
    expect(safeFileName('')).toBe('statement');
  });

  it('cuts a long text to its first lines and counts them all', () => {
    expect(excerpt('')).toEqual({ lines: [], total: 0 });
    expect(excerpt('\uFEFFa,b\r\n1,2\r\n')).toEqual({ lines: ['a,b', '1,2'], total: 2 });
    const long = Array.from({ length: 450 }, (_, i) => `row ${i + 1}`).join('\n');
    const cut = excerpt(long);
    expect(cut.total).toBe(450);
    expect(cut.lines).toHaveLength(300);
    expect(cut.lines.at(-1)).toBe('row 300');
  });
});
