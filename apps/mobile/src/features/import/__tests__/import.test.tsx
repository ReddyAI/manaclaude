import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { formatMoney, type CsvMapping, type ImportCommitResult } from '@manaclaude/shared';
import { createSampleData } from '@manaclaude/shared/sample';
import { router } from 'expo-router';
import { BackendError } from '../../../data/backend/client';
import { getBackendConfig, setBackendConfigForTests } from '../../../data/backend/config';
import { getFinance, setFinance } from '../../../data/store';
import {
  commitImport,
  createManualAccount,
  discardImport,
  getImport,
  listImports,
  manualAccountsSupported,
  previewImport,
  undoImport,
} from '../importApi';
import { ImportScreen } from '../ImportScreen';
import { makePreview, monefyPreview, record, row } from './fixtures';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true },
}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));
jest.mock('../pickFile', () => ({
  pickStatementFile: jest.fn(async () => ({
    uri: 'file:///statement.csv',
    name: 'statement.csv',
    mimeType: 'text/csv',
  })),
}));
jest.mock('../importApi', () => ({
  ...jest.requireActual('../importApi'),
  previewImport: jest.fn(),
  commitImport: jest.fn(),
  discardImport: jest.fn(async () => ({})),
  getImport: jest.fn(),
  listImports: jest.fn(async () => []),
  undoImport: jest.fn(),
  manualAccountsSupported: jest.fn(async () => false),
  createManualAccount: jest.fn(),
}));
jest.mock('../../../data/backend/sync', () => ({
  ...jest.requireActual('../../../data/backend/sync'),
  refreshDataset: jest.fn(async () => true),
}));

const preview = previewImport as jest.Mock;
const commit = commitImport as jest.Mock;
const lookup = getImport as jest.Mock;

const saved = (patch: Partial<ImportCommitResult> = {}): ImportCommitResult => ({
  importId: 'imp_1',
  added: 1,
  matched: 0,
  skipped: 0,
  accountsCreated: [],
  transactionIds: ['t1'],
  linked: 0,
  suggested: 0,
  warnings: [],
  ...patch,
});

const press = (id: string) => fireEvent.press(screen.getByTestId(id));
const disabled = (id: string) => Boolean(screen.getByTestId(id).props.accessibilityState?.disabled);
/** The options the n-th preview request was made with. */
const asked = (n = -1) => preview.mock.calls.at(n)![1] as Record<string, unknown>;

async function openWithPreview() {
  await render(<ImportScreen />);
  await press('import-pick');
  await waitFor(() => expect(screen.getByText('statement.csv')).toBeTruthy());
  await press('import-preview');
  await waitFor(() => expect(screen.getByTestId('import-counts')).toBeTruthy());
}

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  (manualAccountsSupported as jest.Mock).mockResolvedValue(false);
  (listImports as jest.Mock).mockResolvedValue([]);
  setFinance(createSampleData());
  setBackendConfigForTests({ url: 'https://api.demo.test', token: 'demo-token' });
});

describe('statement import', () => {
  it('picks a file, previews it, and imports the new rows', async () => {
    preview.mockResolvedValue(makePreview());
    commit.mockResolvedValue(saved());
    await openWithPreview();
    expect(screen.getByText('Row 2')).toBeTruthy();
    expect(screen.getByTestId('import-counts').props.children).toBe('1 to import');
    expect(screen.getByText('NRE Savings · INR')).toBeTruthy();
    await press('import-confirm');
    await waitFor(() => expect(screen.getByTestId('import-result')).toBeTruthy());
    expect(commit).toHaveBeenCalledWith('imp_1', { skipLines: [], keepLines: [] });
    expect(screen.getByText('1 added, 0 already there, 0 left out.')).toBeTruthy();
    expect(await AsyncStorage.getItem('billionaire.pendingImport')).toBeNull();
  });

  it('asks for the backend when it is not set', async () => {
    setBackendConfigForTests({ token: '' });
    await render(<ImportScreen />);
    expect(screen.getByText('Set up the backend first')).toBeTruthy();
  });

  it('sends inclusive dates, shows how many rows fall outside, and refuses bad dates', async () => {
    preview.mockResolvedValue(
      makePreview({ dateRange: { from: '2026-10-01', to: '2026-10-31', excluded: 41 } }),
    );
    await render(<ImportScreen />);
    await press('import-pick');
    await waitFor(() => expect(screen.getByTestId('import-from')).toBeTruthy());
    await fireEvent.changeText(screen.getByTestId('import-from'), '2026-10-31');
    await fireEvent.changeText(screen.getByTestId('import-to'), '2026-10-01');
    await press('import-preview');
    expect(screen.getByTestId('import-date-problem').props.children).toMatch(/after the last date/);
    expect(preview).not.toHaveBeenCalled();

    await fireEvent.changeText(screen.getByTestId('import-from'), '2026-10-01');
    await fireEvent.changeText(screen.getByTestId('import-to'), '2026-10-31');
    await press('import-preview');
    await waitFor(() => expect(screen.getByTestId('import-excluded')).toBeTruthy());
    expect(asked()).toEqual({ fromDate: '2026-10-01', toDate: '2026-10-31' });
    expect(screen.getByTestId('import-excluded').props.children).toMatch(
      /Only 2026-10-01 to 2026-10-31, both days included\. 41 rows are outside/,
    );
  });

  it('will not import an old preview after the choices change', async () => {
    preview.mockResolvedValue(makePreview());
    await openWithPreview();
    expect(disabled('import-confirm')).toBe(false);
    await fireEvent.changeText(screen.getByTestId('import-to'), '2026-10-15');
    expect(screen.getByTestId('import-stale')).toBeTruthy();
    expect(disabled('import-confirm')).toBe(true);
    await press('import-confirm');
    expect(commit).not.toHaveBeenCalled();
    // Each new preview replaces the one before it.
    preview.mockResolvedValue(makePreview({ importId: 'imp_2' }));
    await press('import-preview');
    await waitFor(() => expect(discardImport).toHaveBeenCalledWith('imp_1'));
    expect(disabled('import-confirm')).toBe(false);
  });
});

describe('accounts named in the file (Monefy)', () => {
  it('maps one account to an existing one, leaves another out, and shows totals per account', async () => {
    preview.mockResolvedValue(monefyPreview());
    commit.mockResolvedValue(saved({ added: 1, skipped: 3 }));
    await openWithPreview();
    expect(screen.getByText('The file holds 2 accounts. Choose where each one goes.')).toBeTruthy();
    expect(screen.getByText('Pocket · USD (new account)')).toBeTruthy();
    expect(screen.getByText('3 rows · in $125.50 · out $28.50')).toBeTruthy();
    // Only INR accounts are offered for the INR account in the file.
    expect(screen.queryByTestId('import-source-1-acc_checking')).toBeNull();

    await press('import-source-1-acc_cash_inr');
    expect(disabled('import-confirm')).toBe(true);
    preview.mockResolvedValue(
      monefyPreview({
        importId: 'imp_2',
        rows: monefyPreview().rows.map((r) =>
          r.accountName === 'Travel' ? { ...r, accountId: 'acc_cash_inr', decision: 'new' } : r,
        ),
        accountsToCreate: monefyPreview().accountsToCreate.filter((a) => a.name === 'Pocket'),
      }),
    );
    await press('import-preview');
    await waitFor(() => expect(screen.getByText('Wallet (INR) · INR')).toBeTruthy());
    expect(asked()).toEqual({ accountMappings: { Travel: 'acc_cash_inr' } });

    // Leaving an account out needs no new preview.
    await press('import-source-0-skip');
    expect(screen.queryByText('Pocket · USD (new account)')).toBeNull();
    expect(screen.getByTestId('import-counts').props.children).toBe('1 to import · 3 left out');
    await press('import-confirm');
    await waitFor(() => expect(screen.getByTestId('import-result')).toBeTruthy());
    expect(commit).toHaveBeenCalledWith('imp_2', { skipLines: [2, 3, 5], keepLines: [] });
  });

  it('blocks the save until the date order is confirmed with a new preview', async () => {
    preview.mockResolvedValue(monefyPreview({ requiresDateConfirmation: true }));
    await openWithPreview();
    expect(screen.getByTestId('import-date-confirm')).toBeTruthy();
    expect(disabled('import-confirm')).toBe(true);
    expect(screen.getByText('Confirm how the dates in the file are written.')).toBeTruthy();
    preview.mockResolvedValue(monefyPreview({ importId: 'imp_2' }));
    await press('import-month-first');
    await press('import-preview');
    await waitFor(() => expect(screen.queryByTestId('import-date-confirm')).toBeNull());
    expect(asked()).toEqual({ preferDayFirst: false });
    expect(disabled('import-confirm')).toBe(false);
  });

  it('retries without a single destination when the file turns out to hold several accounts', async () => {
    preview
      .mockRejectedValueOnce(
        new BackendError(
          400,
          'bad_request',
          'This file contains multiple accounts. Map each account separately instead of selecting one destination.',
        ),
      )
      .mockResolvedValue(monefyPreview());
    await render(<ImportScreen />);
    await press('import-pick');
    await waitFor(() => expect(screen.getByTestId('import-account-acc_nre')).toBeTruthy());
    await press('import-account-acc_nre');
    await press('import-preview');
    await waitFor(() => expect(screen.getByTestId('import-counts')).toBeTruthy());
    expect(asked(0)).toEqual({ accountId: 'acc_nre' });
    expect(asked(1)).toEqual({});
    expect(screen.getByTestId('import-notice').props.children).toMatch(/more than one account/);
    expect(screen.queryByTestId('import-stale')).toBeNull();
  });
});

describe('review before saving', () => {
  it('shows a possible duplicate next to the stored transaction and needs keep or skip', async () => {
    const stored = getFinance().transactions.find((t) => t.accountId === 'acc_checking')!;
    preview.mockResolvedValue(
      makePreview({
        rows: [
          row(2, {
            accountId: 'acc_checking',
            currency: 'USD',
            amount: stored.amount,
            date: stored.date,
            rawName: 'From the file A',
          }),
          row(3, {
            accountId: 'acc_checking',
            currency: 'USD',
            amount: stored.amount,
            date: stored.date,
            rawName: 'From the file B',
          }),
          row(4, { accountId: 'acc_checking', currency: 'USD', rawName: 'Plain row' }),
        ],
        duplicateCandidates: [
          { line: 2, transactionIds: [stored.id] },
          { line: 3, transactionIds: [stored.id] },
        ],
      }),
    );
    commit.mockResolvedValue(saved({ added: 2, skipped: 1 }));
    await openWithPreview();
    expect(screen.getByText('In the file, line 2')).toBeTruthy();
    expect(screen.getAllByText('Already in Everyday Checking')).toHaveLength(2);
    expect(screen.getAllByText(stored.rawName).length).toBeGreaterThanOrEqual(2);
    expect(disabled('import-confirm')).toBe(true);
    expect(screen.getByText('2 possible duplicates need a choice: keep or skip.')).toBeTruthy();

    await press('import-keep-2');
    expect(disabled('import-confirm')).toBe(true);
    await press('import-skip-3');
    expect(disabled('import-confirm')).toBe(false);
    await press('import-confirm');
    await waitFor(() => expect(screen.getByTestId('import-result')).toBeTruthy());
    expect(commit).toHaveBeenCalledWith('imp_1', { skipLines: [3], keepLines: [2] });
  });

  it('lists unreadable lines and saves the rest only after they are knowingly left out', async () => {
    preview.mockResolvedValue(
      makePreview({
        errors: [
          { line: 5, message: 'No amount on this row.' },
          { line: 9, message: 'Can\'t read the date "31/31/2026" as DD/MM/YYYY.' },
        ],
      }),
    );
    commit.mockResolvedValue(saved({ skipped: 2 }));
    await openWithPreview();
    expect(screen.getByText('Line 5: No amount on this row.')).toBeTruthy();
    expect(disabled('import-confirm')).toBe(true);
    await press('import-skip-errors');
    expect(disabled('import-confirm')).toBe(false);
    await press('import-confirm');
    await waitFor(() => expect(screen.getByTestId('import-result')).toBeTruthy());
    expect(commit).toHaveBeenCalledWith('imp_1', { skipLines: [5, 9], keepLines: [] });
  });

  it('does not offer to save rows that have no account', async () => {
    preview.mockResolvedValue(
      makePreview({ rows: [row(2, { accountId: null, decision: 'needs_account' })] }),
    );
    await openWithPreview();
    expect(screen.getByTestId('import-counts').props.children).toBe(
      '0 to import · 1 with no account',
    );
    expect(screen.getByText('Nothing to import')).toBeTruthy();
    expect(disabled('import-confirm')).toBe(true);
    expect(screen.getByText(/does not say which account it is from/)).toBeTruthy();
  });
});

describe('single rows left out by hand', () => {
  const ticked = (line: number) =>
    Boolean(screen.getByTestId(`import-row-tick-${line}`).props.accessibilityState?.checked);
  const counts = () => screen.getByTestId('import-counts').props.children as string;
  const inr = (minor: number) => formatMoney(minor, 'INR');

  it('leaves one row out, with counts and totals to match, and puts it back', async () => {
    preview.mockResolvedValue(makePreview({ rows: [row(2), row(3), row(4, { amount: 500_00 })] }));
    commit.mockResolvedValue(saved({ added: 2, skipped: 1 }));
    await openWithPreview();
    expect(counts()).toBe('3 to import');
    expect(ticked(3)).toBe(true);
    expect(screen.getByText(`3 rows · in ${inr(500_00)} · out ${inr(2_500_00)}`)).toBeTruthy();

    await press('import-row-tick-3');
    expect(ticked(3)).toBe(false);
    expect(counts()).toBe('2 to import · 1 left out');
    expect(screen.getByText(`2 rows · in ${inr(500_00)} · out ${inr(1_250_00)}`)).toBeTruthy();
    expect(screen.getByText('Import 2 rows')).toBeTruthy();
    expect(screen.getByTestId('import-left-out-by-hand').props.children).toMatch(
      /^1 row left out by you/,
    );

    await press('import-put-rows-back');
    expect(ticked(3)).toBe(true);
    expect(counts()).toBe('3 to import');

    await press('import-row-tick-4');
    await press('import-confirm');
    await waitFor(() => expect(screen.getByTestId('import-result')).toBeTruthy());
    expect(commit).toHaveBeenCalledWith('imp_1', { skipLines: [4], keepLines: [] });
    // The totals shown with the result are the ones that were sent: without line 4.
    expect(screen.getByText(`2 rows · in ${inr(0)} · out ${inr(2_500_00)}`)).toBeTruthy();
  });

  it('keeps a row left out through a new preview, and only sends lines that are in it', async () => {
    const all = [row(2), row(3, { date: '2026-10-20' }), row(4)];
    preview.mockResolvedValue(makePreview({ rows: all }));
    commit.mockResolvedValue(saved());
    await openWithPreview();
    await press('import-row-tick-2');
    await press('import-row-tick-3');
    expect(counts()).toBe('1 to import · 2 left out');

    // Narrower dates: line 3 falls outside them and is not in the new preview.
    preview.mockResolvedValue(
      makePreview({
        importId: 'imp_2',
        rows: [all[0]!, all[2]!],
        dateRange: { from: null, to: '2026-10-15', excluded: 1 },
      }),
    );
    await fireEvent.changeText(screen.getByTestId('import-to'), '2026-10-15');
    expect(disabled('import-confirm')).toBe(true);
    await press('import-preview');
    await waitFor(() => expect(screen.getByTestId('import-excluded')).toBeTruthy());
    expect(ticked(2)).toBe(false);
    expect(counts()).toBe('1 to import · 1 left out');
    expect(screen.getByText(`1 row · in ${inr(0)} · out ${inr(1_250_00)}`)).toBeTruthy();

    // Wider again: line 3 is back in the file's rows, and still left out.
    preview.mockResolvedValue(makePreview({ importId: 'imp_3', rows: all }));
    await fireEvent.changeText(screen.getByTestId('import-to'), '');
    await press('import-preview');
    await waitFor(() => expect(screen.queryByTestId('import-excluded')).toBeNull());
    expect([ticked(2), ticked(3), ticked(4)]).toEqual([false, false, true]);
    expect(counts()).toBe('1 to import · 2 left out');
    await press('import-confirm');
    await waitFor(() => expect(screen.getByTestId('import-result')).toBeTruthy());
    expect(commit).toHaveBeenCalledWith('imp_3', { skipLines: [2, 3], keepLines: [] });
  });

  it('is sent together with duplicate answers and unreadable lines, each line once', async () => {
    const stored = getFinance().transactions.find((t) => t.accountId === 'acc_checking')!;
    const usd = { accountId: 'acc_checking', currency: 'USD' };
    preview.mockResolvedValue(
      makePreview({
        rows: [
          row(2, { ...usd, amount: stored.amount, date: stored.date }),
          row(3, { ...usd, amount: stored.amount, date: stored.date }),
          row(4, usd),
          row(5, usd),
          row(6, { ...usd, decision: 'already_imported' }),
        ],
        duplicateCandidates: [
          { line: 2, transactionIds: [stored.id] },
          { line: 3, transactionIds: [stored.id] },
        ],
        errors: [{ line: 9, message: 'No amount on this row.' }],
      }),
    );
    commit.mockResolvedValue(saved({ added: 2, matched: 1, skipped: 3 }));
    await openWithPreview();
    // Rows with a question of their own, or already stored, have no tick box.
    expect(screen.queryByTestId('import-row-tick-2')).toBeNull();
    expect(screen.queryByTestId('import-row-tick-6')).toBeNull();
    await press('import-row-tick-5');
    expect(disabled('import-confirm')).toBe(true);
    await press('import-keep-2');
    await press('import-skip-3');
    await press('import-skip-errors');
    expect(counts()).toBe('2 to import · 1 already there · 3 left out (2 rows, 1 unreadable line)');
    expect(disabled('import-confirm')).toBe(false);
    await press('import-confirm');
    await waitFor(() => expect(screen.getByTestId('import-result')).toBeTruthy());
    expect(commit).toHaveBeenCalledWith('imp_1', { skipLines: [3, 5, 9], keepLines: [2] });
    expect(screen.getByText('2 added, 1 already there, 3 left out.')).toBeTruthy();
  });

  it('stays left out when transactions change during the review, even as a possible duplicate', async () => {
    const usd = { accountId: 'acc_checking', currency: 'USD' };
    const rows = [row(2, usd), row(3, usd), row(4, usd)];
    preview.mockResolvedValue(makePreview({ rows }));
    commit
      .mockRejectedValueOnce(
        new BackendError(409, 'import_preview_changed', 'Transactions changed. Preview again.'),
      )
      .mockResolvedValue(saved({ added: 2, skipped: 1 }));
    await openWithPreview();
    await press('import-row-tick-3');
    // A sync added something that looks like line 3 while the review was open.
    preview.mockResolvedValue(
      makePreview({
        importId: 'imp_2',
        rows,
        duplicateCandidates: [{ line: 3, transactionIds: ['txn_new_from_sync'] }],
      }),
    );
    await press('import-confirm');
    await waitFor(() =>
      expect(screen.getByTestId('import-notice').props.children).toMatch(/changed while you/),
    );
    // The row has its own question now; having been left out, it counts as "skip".
    expect(screen.queryByTestId('import-row-tick-3')).toBeNull();
    expect(screen.getByText('Will be left out')).toBeTruthy();
    expect(counts()).toBe('2 to import · 1 left out');
    expect(disabled('import-confirm')).toBe(false);

    // Answering "keep both" brings it back in...
    await press('import-keep-3');
    expect(counts()).toBe('3 to import');
    // ...and "skip" leaves it out again.
    await press('import-skip-3');
    await press('import-confirm');
    await waitFor(() => expect(screen.getByTestId('import-result')).toBeTruthy());
    expect(commit).toHaveBeenLastCalledWith('imp_2', { skipLines: [3], keepLines: [] });
  });

  it('puts a row back, and says so, when a PDF is read again and its rows moved', async () => {
    const pdf = { format: 'pdf' as const, fileName: 'statement.pdf' };
    preview.mockResolvedValue(makePreview({ ...pdf, rows: [row(2), row(3), row(4)] }));
    await openWithPreview();
    await press('import-row-tick-2');
    await press('import-row-tick-3');
    preview.mockResolvedValue(
      makePreview({
        ...pdf,
        importId: 'imp_2',
        rows: [row(2), row(3, { rawName: 'Row 4' }), row(4, { rawName: 'Row 3' })],
        dateRange: { from: '2026-10-01', to: null, excluded: 0 },
      }),
    );
    await fireEvent.changeText(screen.getByTestId('import-from'), '2026-10-01');
    await press('import-preview');
    await waitFor(() => expect(screen.getByTestId('import-notice')).toBeTruthy());
    expect(screen.getByTestId('import-notice').props.children).toMatch(
      /^1 row you left out was read differently this time, so it is back in the import/,
    );
    expect([ticked(2), ticked(3), ticked(4)]).toEqual([false, true, true]);
    expect(counts()).toBe('2 to import · 1 left out');
  });

  it('shows more rows on request, with counts for the whole file', async () => {
    const many = Array.from({ length: 170 }, (_, i) => row(i + 2));
    preview.mockResolvedValue(makePreview({ rows: many }));
    commit.mockResolvedValue(saved({ added: 169, skipped: 1 }));
    await openWithPreview();
    expect(counts()).toBe('170 to import');
    expect(screen.getByTestId('import-rows-shown').props.children).toMatch(/^Showing 60 of 170/);
    expect(screen.queryByTestId('import-row-tick-150')).toBeNull();
    await press('import-more-rows');
    expect(screen.getByTestId('import-row-tick-150')).toBeTruthy();
    expect(screen.getByText('Show 10 more')).toBeTruthy();
    await press('import-row-tick-150');
    expect(counts()).toBe('169 to import · 1 left out');
    await press('import-more-rows');
    expect(screen.queryByTestId('import-more-rows')).toBeNull();
    await press('import-confirm');
    await waitFor(() => expect(screen.getByTestId('import-result')).toBeTruthy());
    expect(commit).toHaveBeenCalledWith('imp_1', { skipLines: [150], keepLines: [] });
  });
});

describe('bank CSV layout', () => {
  const mapping: CsvMapping = {
    delimiter: ',',
    hasHeader: true,
    skipRows: 0,
    dateColumn: 0,
    dateFormat: 'DD/MM/YYYY',
    amountMode: 'single',
    amountColumn: 2,
    debitColumn: null,
    creditColumn: null,
    invertSign: false,
    decimalSeparator: '.',
    descriptionColumn: 1,
    notesColumn: null,
    categoryColumn: null,
    currencyColumn: null,
    idColumn: null,
  };
  const csv = {
    headers: ['Txn Date', 'Narration', 'Withdrawal', 'Deposit'],
    signature: 'txn_date|narration|withdrawal|deposit',
    suggestedMapping: mapping,
    missing: [],
    dateFormatAmbiguous: true,
    dateFormatCandidates: ['DD/MM/YYYY' as const, 'MM/DD/YYYY' as const],
    usedSavedMapping: false,
  };

  it('confirms the date order, sets debit and credit columns and skips lines at the top', async () => {
    preview.mockResolvedValue(makePreview({ csv, mapping }));
    await openWithPreview();
    expect(screen.getByTestId('import-date-confirm')).toBeTruthy();
    expect(disabled('import-confirm')).toBe(true);

    await press('import-date-format-DD/MM/YYYY');
    await press('import-show-columns');
    await press('import-amount-split');
    await press('import-col-debit-2');
    await press('import-col-credit-3');
    preview.mockResolvedValue(makePreview({ importId: 'imp_2', csv, mapping }));
    await press('import-preview');
    await waitFor(() => expect(screen.queryByTestId('import-date-confirm')).toBeNull());
    expect(asked().mapping).toMatchObject({
      dateFormat: 'DD/MM/YYYY',
      amountMode: 'debit_credit',
      debitColumn: 2,
      creditColumn: 3,
      amountColumn: null,
    });
    expect(disabled('import-confirm')).toBe(false);

    // Lines above the header: the columns are worked out again from the new header line.
    await press('import-preamble-more');
    await press('import-preamble-more');
    expect(screen.getByTestId('import-preamble').props.children).toBe('2');
    await press('import-preview');
    await waitFor(() => expect(asked()).toEqual({ skipRows: 2 }));
  });

  it("reads a file from its own first line when a saved layout carries another file's skipped lines", async () => {
    const savedCsv = { ...csv, dateFormatAmbiguous: false, usedSavedMapping: true };
    preview
      .mockResolvedValueOnce(makePreview({ csv: savedCsv, mapping: { ...mapping, skipRows: 2 } }))
      .mockResolvedValue(
        makePreview({
          importId: 'imp_2',
          rows: [row(2), row(3)],
          csv: { ...savedCsv, usedSavedMapping: false },
          mapping,
        }),
      );
    await openWithPreview();
    expect(preview).toHaveBeenCalledTimes(2);
    expect(asked(0)).toEqual({});
    expect((asked(1).mapping as CsvMapping).skipRows).toBe(0);
    expect(asked(1).skipRows).toBeUndefined();
    expect(discardImport).toHaveBeenCalledWith('imp_1');
    expect(screen.getByTestId('import-counts').props.children).toBe('2 to import');
    expect(screen.getByTestId('import-saved-layout')).toBeTruthy();
    expect(screen.queryByTestId('import-stale')).toBeNull();
    expect(disabled('import-confirm')).toBe(false);
  });

  it('asks for the columns when they cannot be worked out', async () => {
    preview.mockResolvedValue(
      makePreview({
        status: 'needs_mapping',
        rows: [],
        csv: { ...csv, missing: ['amount'], dateFormatAmbiguous: false },
      }),
    );
    await render(<ImportScreen />);
    await press('import-pick');
    await waitFor(() => expect(screen.getByTestId('import-preview')).toBeTruthy());
    await press('import-preview');
    await waitFor(() => expect(screen.getByTestId('import-columns')).toBeTruthy());
    expect(screen.queryByTestId('import-confirm')).toBeNull();
    await press('import-col-amount-3');
    await press('import-invert-sign');
    preview.mockResolvedValue(makePreview({ importId: 'imp_2', csv, mapping }));
    await press('import-preview');
    await waitFor(() => expect(screen.getByTestId('import-confirm')).toBeTruthy());
    expect(asked().mapping).toMatchObject({ amountColumn: 3, invertSign: true });
  });
});

describe('saves that do not go to plan', () => {
  it('makes a fresh preview when transactions changed during the review', async () => {
    const stored = getFinance().transactions.find((t) => t.accountId === 'acc_checking')!;
    const rows = [
      row(2, {
        accountId: 'acc_checking',
        currency: 'USD',
        amount: stored.amount,
        date: stored.date,
      }),
      row(3, { accountId: 'acc_checking', currency: 'USD' }),
    ];
    preview.mockResolvedValue(
      makePreview({ rows, duplicateCandidates: [{ line: 2, transactionIds: [stored.id] }] }),
    );
    commit.mockRejectedValueOnce(
      new BackendError(
        409,
        'import_preview_changed',
        'Transactions or import state changed while saving. Preview the file again.',
      ),
    );
    await openWithPreview();
    await press('import-keep-2');
    preview.mockResolvedValue(
      makePreview({
        importId: 'imp_2',
        rows,
        duplicateCandidates: [
          { line: 2, transactionIds: [stored.id] },
          { line: 3, transactionIds: ['txn_new_from_sync'] },
        ],
      }),
    );
    await press('import-confirm');
    await waitFor(() => expect(screen.getByTestId('import-notice')).toBeTruthy());
    expect(screen.getByTestId('import-notice').props.children).toMatch(
      /changed while you were reviewing/,
    );
    expect(preview).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenCalledTimes(1);
    // The answer for the unchanged pair stays; the new pair needs its own.
    expect(screen.getByText('1 possible duplicate needs a choice: keep or skip.')).toBeTruthy();
    expect(disabled('import-confirm')).toBe(true);
    expect(await AsyncStorage.getItem('billionaire.pendingImport')).toBeNull();
  });

  it('asks the Worker what happened when the answer to a save is lost, and never saves twice', async () => {
    preview.mockResolvedValue(makePreview());
    commit.mockRejectedValue(new BackendError(0, 'offline', "The backend can't be reached."));
    lookup.mockResolvedValue({ ...record({ rowsAdded: 1 }), preview: null });
    await openWithPreview();
    await press('import-confirm');
    await waitFor(() => expect(screen.getByTestId('import-result')).toBeTruthy());
    expect(commit).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith('imp_1');
    expect(screen.getByText('1 added, 0 already there, 0 left out.')).toBeTruthy();
    expect(screen.getByText(/read back from\s+your Worker/)).toBeTruthy();
  });

  it('holds off when the Worker cannot be asked, then reports that nothing was saved', async () => {
    preview.mockResolvedValue(makePreview());
    commit.mockRejectedValue(new BackendError(0, 'offline', "The backend can't be reached."));
    lookup.mockRejectedValueOnce(new BackendError(0, 'offline', "The backend can't be reached."));
    await openWithPreview();
    await press('import-confirm');
    await waitFor(() => expect(screen.getByTestId('import-unsure')).toBeTruthy());
    expect(screen.getByText('Not sure this was saved')).toBeTruthy();
    expect(screen.queryByTestId('import-confirm')).toBeNull();
    expect(JSON.parse((await AsyncStorage.getItem('billionaire.pendingImport'))!)).toMatchObject({
      importId: 'imp_1',
      fileName: 'statement.csv',
      scope: getBackendConfig().scope,
    });

    lookup.mockResolvedValue({ ...record({ status: 'preview' }), preview: null });
    await press('import-check');
    await waitFor(() => expect(screen.getByTestId('import-notice')).toBeTruthy());
    expect(screen.getByTestId('import-notice').props.children).toMatch(/Nothing was saved/);
    expect(screen.getByTestId('import-confirm')).toBeTruthy();
    expect(await AsyncStorage.getItem('billionaire.pendingImport')).toBeNull();
  });

  it('says so while the Worker is still saving', async () => {
    preview.mockResolvedValue(makePreview());
    commit.mockRejectedValue(
      new BackendError(409, 'conflict', 'This import is already being saved.'),
    );
    lookup.mockResolvedValue({ ...record({ status: 'committing' }), preview: null });
    await openWithPreview();
    await press('import-confirm');
    await waitFor(() => expect(screen.getByText('Still saving')).toBeTruthy());
    expect(screen.getByTestId('import-retry')).toBeTruthy();
  });

  it('finds an import that was cut off the last time the app was open', async () => {
    await AsyncStorage.setItem(
      'billionaire.pendingImport',
      JSON.stringify({
        scope: getBackendConfig().scope,
        importId: 'imp_7',
        fileName: 'history.csv',
        startedAt: '',
      }),
    );
    lookup.mockResolvedValue({
      ...record({ id: 'imp_7', fileName: 'history.csv', rowsAdded: 30 }),
      preview: null,
    });
    await render(<ImportScreen />);
    await waitFor(() => expect(screen.getByTestId('import-result')).toBeTruthy());
    expect(lookup).toHaveBeenCalledWith('imp_7');
    expect(screen.getByText('30 added, 0 already there, 0 left out.')).toBeTruthy();
    expect(commit).not.toHaveBeenCalled();
  });

  it('ignores a cut-off import that belongs to another backend', async () => {
    await AsyncStorage.setItem(
      'billionaire.pendingImport',
      JSON.stringify({
        scope: 'another-backend',
        importId: 'imp_7',
        fileName: 'history.csv',
        startedAt: '',
      }),
    );
    await render(<ImportScreen />);
    await act(async () => {
      await new Promise((r) => setImmediate(r));
    });
    expect(lookup).not.toHaveBeenCalled();
    expect(screen.getByTestId('import-pick')).toBeTruthy();
  });

  it('shows a warning that came with a successful save, and undoes the import', async () => {
    preview.mockResolvedValue(makePreview());
    commit.mockResolvedValue(
      saved({
        added: 4,
        warnings: ['Transactions saved; automatic transfer processing needs to be retried.'],
      }),
    );
    (undoImport as jest.Mock).mockResolvedValue(4);
    await openWithPreview();
    await press('import-confirm');
    await waitFor(() => expect(screen.getByTestId('import-save-warning')).toBeTruthy());
    expect(screen.getByTestId('import-save-warning').props.children).toMatch(
      /do not import this file again/,
    );
    await press('import-undo');
    expect(undoImport).not.toHaveBeenCalled();
    await press('import-undo-confirm');
    await waitFor(() => expect(screen.getByTestId('import-undone')).toBeTruthy());
    expect(undoImport).toHaveBeenCalledWith('imp_1');
    expect(screen.getByTestId('import-undone').props.children).toMatch(/Removed 4 transactions/);
  });
});

describe('history', () => {
  it('lists saved and undone imports, hides unsaved previews, and undoes after a second press', async () => {
    (listImports as jest.Mock).mockResolvedValue([
      record({
        id: 'imp_3',
        fileName: 'october.csv',
        rowsAdded: 12,
        rowsMatched: 2,
        rowsSkipped: 1,
      }),
      record({ id: 'imp_2', fileName: 'draft.csv', status: 'preview' }),
      record({ id: 'imp_1', fileName: 'september.csv', status: 'undone' }),
    ]);
    (undoImport as jest.Mock).mockResolvedValue(12);
    await render(<ImportScreen />);
    await fireEvent.press(screen.getByText('History'));
    await waitFor(() => expect(screen.getByText('october.csv')).toBeTruthy());
    expect(screen.getByText('september.csv')).toBeTruthy();
    expect(screen.queryByText('draft.csv')).toBeNull();
    expect(screen.getByText(/12 added, 2 already there, 1 left out/)).toBeTruthy();
    expect(screen.queryByTestId('import-undo-imp_1')).toBeNull();
    await press('import-undo-imp_3');
    expect(undoImport).not.toHaveBeenCalled();
    await press('import-undo-confirm-imp_3');
    await waitFor(() => expect(screen.getByTestId('import-history-note')).toBeTruthy());
    expect(undoImport).toHaveBeenCalledWith('imp_3');
    expect(screen.getByTestId('import-history-note').props.children).toMatch(
      /Removed 12 transactions from october.csv/,
    );
  });

  it('leads to the stored file of an import, and to all stored statements', async () => {
    (listImports as jest.Mock).mockResolvedValue([
      record({ id: 'imp_3', fileName: 'october.csv' }),
      record({ id: 'imp_1', fileName: 'september.csv', status: 'undone' }),
    ]);
    await render(<ImportScreen />);
    await fireEvent.press(screen.getByText('History'));
    await waitFor(() => expect(screen.getByText('october.csv')).toBeTruthy());
    await press('import-file-imp_1');
    expect(router.push).toHaveBeenLastCalledWith({
      pathname: '/vault/[id]',
      params: { id: 'imp_1' },
    });
    await press('import-open-vault');
    expect(router.push).toHaveBeenLastCalledWith('/vault');
  });
});

describe('a new account made by hand', () => {
  const create = createManualAccount as jest.Mock;
  const made = (patch: object = {}) => ({
    account: { id: 'acc_made', name: 'NRO Fixed', currency: 'INR' },
    replayed: false,
    ...patch,
  });
  const offline = () => new BackendError(0, 'offline', "The backend can't be reached.");
  const stored = async () => {
    const raw = await AsyncStorage.getItem('billionaire.pendingManualAccount');
    return raw
      ? (JSON.parse(raw) as { scope: string; source: string | null; request: object })
      : null;
  };

  async function openForm() {
    (manualAccountsSupported as jest.Mock).mockResolvedValue(true);
    await render(<ImportScreen />);
    await press('import-pick');
    await waitFor(() => expect(screen.getByTestId('import-account-new')).toBeTruthy());
    await press('import-account-new');
  }
  async function fillUnknown() {
    await fireEvent.changeText(screen.getByTestId('new-account-name'), ' NRO Fixed ');
    await press('new-account-type-savings');
    await press('new-account-subtype-nro');
    await press('new-account-currency-INR');
    await press('new-account-balance-unknown');
  }

  it('is not offered while the Worker has no route for it', async () => {
    await render(<ImportScreen />);
    await press('import-pick');
    await waitFor(() => expect(screen.getByTestId('import-no-manual-accounts')).toBeTruthy());
    expect(screen.queryByTestId('import-account-new')).toBeNull();
  });

  it('asks whether the balance is known, and sends unknown as null with a retry key', async () => {
    create.mockResolvedValue(made());
    preview.mockResolvedValue(makePreview());
    await openForm();
    await fireEvent.changeText(screen.getByTestId('new-account-name'), ' NRO Fixed ');
    await press('new-account-type-savings');
    await press('new-account-subtype-nro');
    await press('new-account-currency-INR');
    // No balance choice yet: nothing can be sent, and zero is never assumed.
    expect(disabled('new-account-create')).toBe(true);
    expect(screen.getByTestId('new-account-problem').props.children).toMatch(
      /whether you know the balance/,
    );
    await press('new-account-balance-unknown');
    expect(screen.getByText(/show as unknown, not as zero/)).toBeTruthy();
    await press('new-account-create');
    await waitFor(() => expect(screen.queryByTestId('import-new-account')).toBeNull());

    const request = create.mock.calls[0]![0] as Record<string, unknown>;
    // Exactly the fields the Worker accepts: no mask, no bare balance, no institution.
    expect(Object.keys(request).sort()).toEqual(
      ['currency', 'currentBalance', 'idempotencyKey', 'name', 'subtype', 'type'].sort(),
    );
    expect(request).toMatchObject({
      name: 'NRO Fixed',
      type: 'savings',
      subtype: 'nro',
      currency: 'INR',
      currentBalance: null,
    });
    expect(request.idempotencyKey).toMatch(/^[A-Za-z0-9_-]{8,200}$/);
    expect(await stored()).toBeNull();
    await press('import-preview');
    await waitFor(() => expect(asked()).toEqual({ accountId: 'acc_made' }));
  });

  it('sends a known balance and an opening balance in minor units with their dates', async () => {
    create.mockResolvedValue(made());
    await openForm();
    await fireEvent.changeText(screen.getByTestId('new-account-name'), 'Orchard savings');
    await press('new-account-currency-INR');
    await press('new-account-balance-known');
    await fireEvent.changeText(screen.getByTestId('new-account-balance'), '450');
    // The date starts as today (the fixed test clock).
    expect(screen.getByTestId('new-account-balance-date').props.value).toBe('2026-11-05');
    await fireEvent.changeText(screen.getByTestId('new-account-balance-date'), '2026-11-01');
    await press('new-account-net-worth');
    await press('new-account-has-opening');
    await fireEvent.changeText(screen.getByTestId('new-account-opening'), '1,200.50');
    await fireEvent.changeText(screen.getByTestId('new-account-opening-date'), '2026-12-01');
    expect(screen.getByTestId('new-account-problem').props.children).toMatch(/can't be after/);
    expect(disabled('new-account-create')).toBe(true);
    await fireEvent.changeText(screen.getByTestId('new-account-opening-date'), '2025-01-01');
    await press('new-account-create');
    await waitFor(() => expect(create).toHaveBeenCalled());
    const { idempotencyKey: _key, ...rest } = create.mock.calls[0]![0] as Record<string, unknown>;
    expect(rest).toEqual({
      name: 'Orchard savings',
      type: 'savings',
      currency: 'INR',
      currentBalance: { amount: 45_000, asOf: '2026-11-01T12:00:00.000Z' },
      openingBalance: { amount: 120_050, date: '2025-01-01' },
      includeInNetWorth: false,
    });
  });

  it('keeps the original request when the answer is lost and sends exactly that again', async () => {
    create.mockRejectedValueOnce(offline()).mockResolvedValue(made({ replayed: true }));
    await openForm();
    await fillUnknown();
    await press('new-account-create');
    await waitFor(() => expect(screen.getByTestId('import-account-pending')).toBeTruthy());
    expect(screen.getByText(/Not sure the account "NRO Fixed" was made/)).toBeTruthy();
    // No second account can be started while the first is undecided.
    expect(screen.queryByTestId('import-account-new')).toBeNull();
    expect(screen.queryByTestId('import-new-account')).toBeNull();
    const first = create.mock.calls[0]![0] as object;
    expect(await stored()).toMatchObject({
      scope: getBackendConfig().scope,
      source: null,
      request: first,
    });

    await press('import-account-retry');
    await waitFor(() => expect(screen.queryByTestId('import-account-pending')).toBeNull());
    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1]![0]).toEqual(first);
    expect(screen.getByTestId('import-notice').props.children).toMatch(
      /no second account was made/,
    );
    expect(await stored()).toBeNull();
    expect(screen.getByTestId('import-account-new')).toBeTruthy();
  });

  const earlier = {
    idempotencyKey: 'b1309553-5329-4772-b642-cae13ecf551a',
    name: 'Orchard savings',
    type: 'savings',
    currency: 'INR',
    currentBalance: { amount: 45_000, asOf: '2026-11-01T12:00:00.000Z' },
  };

  it('offers the same request again after the app was closed', async () => {
    await AsyncStorage.setItem(
      'billionaire.pendingManualAccount',
      JSON.stringify({ scope: getBackendConfig().scope, source: null, request: earlier }),
    );
    create.mockResolvedValue(made({ replayed: true }));
    (manualAccountsSupported as jest.Mock).mockResolvedValue(true);
    await render(<ImportScreen />);
    await press('import-pick');
    await waitFor(() => expect(screen.getByTestId('import-account-pending')).toBeTruthy());
    await press('import-account-retry');
    await waitFor(() => expect(create).toHaveBeenCalledWith(earlier));
  });

  it('ignores a request that was stored for another backend', async () => {
    await AsyncStorage.setItem(
      'billionaire.pendingManualAccount',
      JSON.stringify({ scope: 'another-backend', source: null, request: earlier }),
    );
    (manualAccountsSupported as jest.Mock).mockResolvedValue(true);
    await render(<ImportScreen />);
    await press('import-pick');
    await waitFor(() => expect(screen.getByTestId('import-account-new')).toBeTruthy());
    expect(screen.queryByTestId('import-account-pending')).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it('never re-sends or swaps the key by itself after a conflict', async () => {
    create.mockRejectedValue(
      new BackendError(
        409,
        'idempotency_conflict',
        'This creation key was already used for different account details.',
      ),
    );
    await openForm();
    await fillUnknown();
    await press('new-account-create');
    await waitFor(() => expect(screen.getByTestId('import-account-pending')).toBeTruthy());
    expect(screen.getByText(/already has a different request stored/)).toBeTruthy();
    expect(screen.queryByTestId('import-account-retry')).toBeNull();
    expect(create).toHaveBeenCalledTimes(1);
    expect(await stored()).not.toBeNull();
    await press('import-account-forget');
    await waitFor(() => expect(screen.getByTestId('import-account-new')).toBeTruthy());
    expect(await stored()).toBeNull();
  });

  it('drops a request the Worker refused outright', async () => {
    create.mockRejectedValue(
      new BackendError(400, 'invalid_body', 'currency: use three uppercase letters.'),
    );
    await openForm();
    await fillUnknown();
    await press('new-account-create');
    await waitFor(() => expect(screen.getByTestId('import-error')).toBeTruthy());
    expect(screen.getByTestId('import-error').props.children).toMatch(/three uppercase letters/);
    expect(screen.queryByTestId('import-account-pending')).toBeNull();
    expect(await stored()).toBeNull();
  });

  it('makes an account for one account named in a Monefy file, in that currency, and maps it', async () => {
    (manualAccountsSupported as jest.Mock).mockResolvedValue(true);
    create.mockResolvedValue(
      made({ account: { id: 'acc_made', name: 'Travel', currency: 'INR' } }),
    );
    preview.mockResolvedValue(monefyPreview());
    await openWithPreview();
    await press('import-source-1-new');
    expect(screen.getByTestId('new-account-name').props.value).toBe('Travel');
    expect(screen.getByText('INR, because the rows in the file are in INR.')).toBeTruthy();
    expect(screen.queryByTestId('new-account-currency-USD')).toBeNull();
    await press('new-account-type-other_asset');
    await press('new-account-balance-unknown');
    await press('new-account-create');
    await waitFor(() => expect(screen.queryByTestId('import-new-account')).toBeNull());
    expect(create.mock.calls[0]![0]).toMatchObject({
      name: 'Travel',
      type: 'other_asset',
      currency: 'INR',
      currentBalance: null,
    });
    // The new account is the choice for that source; the old preview may not be saved.
    expect(disabled('import-confirm')).toBe(true);
    await press('import-preview');
    await waitFor(() => expect(asked()).toEqual({ accountMappings: { Travel: 'acc_made' } }));
  });
});
