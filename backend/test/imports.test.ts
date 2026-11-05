import { beforeEach, describe, expect, it } from 'vitest';
import qifText from './fixtures/imports/card-with-splits.qif?raw';
import ofxText from './fixtures/imports/checking.ofx?raw';
import sureText from './fixtures/imports/sure-export.ndjson?raw';
import actualText from './fixtures/imports/actual-export.csv?raw';
import indiaCsv from './fixtures/imports/india-nre-dayfirst.csv?raw';
import pdfText from './fixtures/imports/nre-october.pdf?raw';
import statementJson from './fixtures/ai/statement-nre.json';
import type { ImportPreview } from '@manaclaude/shared';
import { selectAll } from '../src/db/table';
import { accountsTable, transferLinksTable } from '../src/db/tables';
import {
  commitImport,
  detectFormat,
  getImport,
  previewImport,
  undoImport,
} from '../src/imports/service';
import { fakeAi } from './fakes';
import { addAccount, addTxn, allTxns, db, file, freshDb, spending, testEnv } from './helpers';
import { client, upload } from './worker';

beforeEach(freshDb);

describe('format detection', () => {
  it('recognises each format from its name or first bytes', () => {
    expect(detectFormat('x.qif', qifText)).toBe('qif');
    expect(detectFormat('statement.ofx', ofxText)).toBe('ofx');
    expect(detectFormat('download.qfx', ofxText)).toBe('ofx');
    expect(detectFormat('all.ndjson', sureText)).toBe('sure_ndjson');
    expect(detectFormat('export.csv', actualText)).toBe('actual_csv');
    expect(detectFormat('bank.csv', indiaCsv)).toBe('csv');
    expect(detectFormat('stmt.pdf', '%PDF-1.4')).toBe('pdf');
  });
});

describe('QIF with splits', () => {
  it('imports split parents with exact children and links the card payment', async () => {
    const checking = await addAccount({ type: 'checking', name: 'Everyday Checking' });
    const card = await addAccount({ type: 'credit_card' });
    await addTxn(checking, { date: '2026-11-04', amount: -20_000, rawName: 'CARD AUTOPAY' });
    const p = await previewImport(testEnv, { ...file(qifText, 'card.qif'), accountId: card.id });
    expect(p.counts.new).toBe(3);
    const r = await commitImport(testEnv, p.importId);
    expect(r.added).toBe(3);
    expect(r.linked).toBe(1);
    const txns = await allTxns();
    const parent = txns.find((t) => t.amount === -10_000 && !t.splitParentId)!;
    expect(parent.isSplitParent).toBe(true);
    const children = txns.filter((t) => t.splitParentId === parent.id);
    expect(children.map((c) => [c.amount, c.categoryId])).toEqual(
      expect.arrayContaining([
        [-6_000, 'cat_shopping'],
        [-4_000, 'cat_gifts'],
      ]),
    );
    const s = await spending('2026-11-01', '2026-11-30');
    expect(s.byCategory).toMatchObject({ cat_shopping: 6_000, cat_gifts: 4_000 });
    // Re-import: the parent's fingerprint matches, nothing is added (children included).
    const again = await previewImport(testEnv, {
      ...file(qifText, 'card.qif'),
      accountId: card.id,
    });
    expect((await commitImport(testEnv, again.importId)).added).toBe(0);
    expect(await allTxns()).toHaveLength(txns.length);
  });
});

describe('OFX', () => {
  it('matches the account by mask, uses FITIDs and is idempotent', async () => {
    const checking = await addAccount({ type: 'checking', mask: '4821' });
    const p = await previewImport(testEnv, file(ofxText, 'checking.ofx'));
    expect(p.rows.every((r) => r.accountId === checking.id)).toBe(true);
    expect((await commitImport(testEnv, p.importId)).added).toBe(3);
    const txns = await allTxns();
    expect(txns.map((t) => t.externalId).sort()).toEqual([
      'LK20261102001',
      'LK20261103002',
      'LK20261104003',
    ]);
    expect(txns.every((t) => t.importFingerprint === null)).toBe(true);
    const p2 = await previewImport(testEnv, file(ofxText, 'checking.ofx'));
    expect(p2.counts.alreadyImported).toBe(3);
  });
});

describe('Sure NDJSON', () => {
  it('creates the accounts it names, imports with Sure ids and links the card payment', async () => {
    const p = await previewImport(testEnv, file(sureText, 'all.ndjson'));
    expect(p.accountsToCreate.map((a) => a.name)).toEqual(['Harbor Checking', 'Harbor Visa']);
    expect(p.counts.needsAccount).toBe(4);
    const r = await commitImport(testEnv, p.importId);
    expect(r.accountsCreated).toHaveLength(2);
    expect(r.added).toBe(4);
    expect(r.linked).toBe(1);
    const accounts = await selectAll(db, accountsTable);
    expect(accounts.find((a) => a.name === 'Harbor Visa')?.type).toBe('credit_card');
    const groceries = (await allTxns()).find((t) => t.externalId === 'sure:t1')!;
    expect(groceries).toMatchObject({
      amount: -6_420,
      categoryId: 'cat_groceries',
      tagIds: ['tag_reimbursable'],
    });
    const again = await previewImport(testEnv, file(sureText, 'all.ndjson'));
    expect(again.counts).toMatchObject({ alreadyImported: 4, new: 0 });
  });
});

describe('Actual Budget CSV', () => {
  it('imports splits and transfers between its two accounts', async () => {
    await addAccount({ type: 'checking', name: 'Pine Checking' });
    await addAccount({ type: 'savings', name: 'Pine Savings' });
    const p = await previewImport(testEnv, file(actualText, 'actual.csv'));
    expect(p.format).toBe('actual_csv');
    const r = await commitImport(testEnv, p.importId);
    expect(r.added).toBe(4);
    expect(r.linked).toBe(1);
    const links = await selectAll(db, transferLinksTable);
    expect(links[0]).toMatchObject({ kind: 'transfer', status: 'auto' });
    const parent = (await allTxns()).find((t) => t.isSplitParent)!;
    expect((await allTxns()).filter((t) => t.splitParentId === parent.id)).toHaveLength(2);
  });
});

describe('CSV date formats', () => {
  it('detects day-first dates for an INR account and imports Indian amounts', async () => {
    const nre = await addAccount({ type: 'savings', subtype: 'nre', currency: 'INR' });
    const p = await previewImport(testEnv, { ...file(indiaCsv, 'nre.csv'), accountId: nre.id });
    expect(p.mapping?.dateFormat).toBe('DD/MM/YYYY');
    expect(p.rows.map((r) => [r.date, r.amount])).toEqual([
      ['2026-10-17', 17_624_000],
      ['2026-10-22', -24_000],
      ['2026-11-03', -2_500_000],
    ]);
  });

  it('asks for a mapping when it cannot find the columns, then uses the one given', async () => {
    const checking = await addAccount({ type: 'checking' });
    const odd = 'When,What,How much\n2026-11-01,Thing,-1.00\n';
    const { api } = client();
    const first = await api<{ preview: ImportPreview }>(
      'POST',
      '/v1/imports',
      upload({ accountId: checking.id }, odd, 'odd.csv'),
    );
    expect(first.body.preview.status).toBe('needs_mapping');
    expect(first.body.preview.csv?.headers).toEqual(['When', 'What', 'How much']);
    const mapping = {
      ...first.body.preview.csv!.suggestedMapping,
      dateColumn: 0,
      descriptionColumn: 1,
      amountColumn: 2,
      dateFormat: 'YYYY-MM-DD',
    };
    const second = await api<{ preview: ImportPreview; result: { added: number } }>(
      'POST',
      '/v1/imports',
      upload(
        { accountId: checking.id, mapping: JSON.stringify(mapping), commit: 'true' },
        odd,
        'odd.csv',
      ),
    );
    expect(second.body.result.added).toBe(1);
  });

  it('warns when dates fit more than one format', async () => {
    const checking = await addAccount({ type: 'checking' });
    const csv = 'Date,Description,Amount\n03/04/2026,A,-1.00\n05/06/2026,B,-2.00\n';
    const p = await previewImport(testEnv, { ...file(csv, 'amb.csv'), accountId: checking.id });
    expect(p.warnings.some((w) => w.includes('MM/DD/YYYY or DD/MM/YYYY'))).toBe(true);
  });
});

describe('PDF statements: AI extraction, preview, confirm, reconcile, vault', () => {
  it('previews without saving, reconciles synced rows, and saves only on confirm', async () => {
    const nre = await addAccount({
      type: 'savings',
      subtype: 'nre',
      currency: 'INR',
      mask: '7731',
    });
    // Already synced from a connector, a day off.
    await addTxn(nre, {
      date: '2026-10-21',
      amount: -24_000,
      rawName: 'UPI CHAI POINT',
      source: 'connector',
      externalId: 'c1',
    });
    const ai = fakeAi({ statement: statementJson });
    const preview = await previewImport(
      testEnv,
      { ...file(pdfText, 'nre-october.pdf'), accountId: nre.id },
      ai.deps,
    );
    expect(ai.calls[0]!.pdf?.fileName).toBe('nre-october.pdf');
    expect(preview).toMatchObject({
      format: 'pdf',
      status: 'preview',
      periodStart: '2026-10-01',
      periodEnd: '2026-10-31',
    });
    expect(preview.statementCheck).toMatchObject({
      balances: true,
      openingBalance: 35_000_000,
      closingBalance: 52_576_000,
    });
    expect(preview.rows.map((r) => r.decision)).toEqual(['new', 'existing', 'new']);
    expect(await allTxns()).toHaveLength(1); // nothing saved yet
    const rec = await getImport(db, preview.importId);
    expect(rec.status).toBe('preview');
    expect(await (await testEnv.FILES.get(rec.r2Key))?.text()).toBe(pdfText);

    const result = await commitImport(testEnv, preview.importId, { skipLines: [3] });
    expect(result).toMatchObject({ added: 1, matched: 1, skipped: 1 });
    expect(await allTxns()).toHaveLength(2);
    await expect(commitImport(testEnv, preview.importId)).rejects.toMatchObject({ status: 409 });
  });

  it('refuses commit=true for PDFs over HTTP (the preview step is required)', async () => {
    const nre = await addAccount({ type: 'savings', subtype: 'nre', currency: 'INR' });
    const ai = fakeAi({ statement: statementJson });
    const res = await client(ai.deps).api(
      'POST',
      '/v1/imports',
      upload({ accountId: nre.id, commit: 'true' }, pdfText, 'nre.pdf', 'application/pdf'),
    );
    expect(res.status).toBe(400);
  });

  it('flags a statement whose rows do not add up', async () => {
    const nre = await addAccount({ type: 'savings', subtype: 'nre', currency: 'INR' });
    const ai = fakeAi({ statement: { ...statementJson, closingBalance: '6,00,000.00' } });
    const p = await previewImport(
      testEnv,
      { ...file(pdfText, 'x.pdf'), accountId: nre.id },
      ai.deps,
    );
    expect(p.statementCheck?.balances).toBe(false);
    expect(p.warnings[0]).toMatch(/Some rows may be missing/);
  });

  it('undo removes the rows an import added but keeps the original file', async () => {
    const checking = await addAccount({ type: 'checking' });
    const p = await previewImport(testEnv, {
      ...file('Date,Description,Amount\n2026-11-01,A,-1.00\n', 'a.csv'),
      accountId: checking.id,
    });
    await commitImport(testEnv, p.importId);
    expect(await undoImport(db, p.importId)).toBe(1);
    expect(await allTxns()).toHaveLength(0);
    const rec = await getImport(db, p.importId);
    expect(rec.status).toBe('undone');
    expect(await testEnv.FILES.get(rec.r2Key)).not.toBeNull();
  });
});
