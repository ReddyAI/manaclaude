import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { CsvMapping, ImportCommitResult } from '@manaclaude/shared';
import { createSampleData } from '@manaclaude/shared/sample';
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
});

describe('a new account for a file that names none', () => {
  it('is not offered while the Worker has no route for it', async () => {
    await render(<ImportScreen />);
    await press('import-pick');
    await waitFor(() => expect(screen.getByTestId('import-no-manual-accounts')).toBeTruthy());
    expect(screen.queryByTestId('import-account-new')).toBeNull();
  });

  it('makes the account and selects it once the Worker supports it', async () => {
    (manualAccountsSupported as jest.Mock).mockResolvedValue(true);
    (createManualAccount as jest.Mock).mockResolvedValue({ id: 'acc_made', name: 'NRO Fixed' });
    preview.mockResolvedValue(makePreview());
    await render(<ImportScreen />);
    await press('import-pick');
    await waitFor(() => expect(screen.getByTestId('import-account-new')).toBeTruthy());
    await press('import-account-new');
    expect(disabled('new-account-create')).toBe(true);
    await fireEvent.changeText(screen.getByTestId('new-account-name'), ' NRO Fixed ');
    await press('new-account-type-savings');
    await press('new-account-currency-INR');
    await fireEvent.changeText(screen.getByTestId('new-account-mask'), '4321');
    await press('new-account-create');
    await waitFor(() => expect(screen.queryByTestId('import-new-account')).toBeNull());
    expect(createManualAccount).toHaveBeenCalledWith({
      name: 'NRO Fixed',
      type: 'savings',
      currency: 'INR',
      mask: '4321',
    });
    await press('import-preview');
    await waitFor(() => expect(asked()).toEqual({ accountId: 'acc_made' }));
  });
});
