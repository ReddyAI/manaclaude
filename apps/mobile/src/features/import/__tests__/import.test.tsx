import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ImportPreview } from '@manaclaude/shared';
import { setBackendConfigForTests } from '../../../data/backend/config';
import { commitImport, previewImport } from '../importApi';
import { ImportScreen } from '../ImportScreen';

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
    uri: 'file:///nre.csv',
    name: 'nre-statement.csv',
    mimeType: 'text/csv',
  })),
}));
jest.mock('../importApi', () => ({
  ...jest.requireActual('../importApi'),
  previewImport: jest.fn(),
  commitImport: jest.fn(),
  discardImport: jest.fn(async () => ({})),
}));
jest.mock('../../../data/backend/sync', () => ({
  ...jest.requireActual('../../../data/backend/sync'),
  refreshDataset: jest.fn(async () => true),
}));

const preview: ImportPreview = {
  importId: 'imp_1',
  format: 'csv',
  status: 'preview',
  fileName: 'nre-statement.csv',
  accountId: null,
  rows: [
    {
      line: 2,
      date: '2026-10-03',
      amount: -1_250_000,
      currency: 'INR',
      rawName: 'NEFT TO DEMO PAYEE',
      notes: null,
      categoryName: null,
      externalId: null,
      accountName: null,
      tags: [],
      splits: [],
      transferHint: false,
      kindHint: null,
      pending: false,
      accountId: 'acc_nre',
      fingerprint: 'f1',
      occurrence: 1,
      categoryId: null,
      decision: 'new',
      matchedTransactionId: null,
    },
  ],
  accountsToCreate: [],
  errors: [],
  warnings: [],
  counts: { total: 1, new: 1, alreadyImported: 0, existing: 0, needsAccount: 0 },
  csv: null,
  mapping: null,
  statementCheck: null,
  periodStart: '2026-10-01',
  periodEnd: '2026-10-31',
};

describe('statement import', () => {
  beforeEach(() => setBackendConfigForTests({ url: 'https://api.demo.test', token: 'demo-token' }));

  it('picks a file, previews it, and imports the new rows', async () => {
    (previewImport as jest.Mock).mockResolvedValue(preview);
    (commitImport as jest.Mock).mockResolvedValue({
      importId: 'imp_1',
      added: 1,
      matched: 0,
      skipped: 0,
      accountsCreated: [],
      transactionIds: ['t1'],
      linked: 0,
      suggested: 0,
    });
    await render(<ImportScreen />);
    await fireEvent.press(screen.getByTestId('import-pick'));
    await waitFor(() => expect(screen.getByText('nre-statement.csv')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('import-preview'));
    await waitFor(() => expect(screen.getByTestId('import-counts')).toBeTruthy());
    expect(screen.getByText('NEFT TO DEMO PAYEE')).toBeTruthy();
    expect(screen.getByText('1 new · 0 already there')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('import-confirm'));
    await waitFor(() => expect(screen.getByTestId('import-result')).toBeTruthy());
    expect(commitImport).toHaveBeenCalledWith('imp_1');
    expect(screen.getByText('1 added, 0 already there, 0 skipped.')).toBeTruthy();
  });

  it('asks for the backend when it is not set', async () => {
    setBackendConfigForTests({ token: '' });
    await render(<ImportScreen />);
    expect(screen.getByText('Set up the backend first')).toBeTruthy();
  });
});
