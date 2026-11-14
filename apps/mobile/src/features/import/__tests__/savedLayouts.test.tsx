import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { CsvMapping, ImportMapping } from '@manaclaude/shared';
import { createSampleData } from '@manaclaude/shared/sample';
import { http } from '../../../data/backend/client';
import { setBackendConfigForTests } from '../../../data/backend/config';
import { setFinance } from '../../../data/store';
import { ImportScreen } from '../ImportScreen';
import { layoutAccountText, layoutColumnsText, SavedLayouts } from '../SavedLayouts';

/**
 * Block P: the saved file layouts from GET /v1/import-mappings, read-only.
 * The Worker is a stand-in; every name and number is invented.
 */

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true },
}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));

const realFetch = http.fetch;
const sample = createSampleData();
const checking = sample.accounts.find((a) => a.type === 'checking')!;

const mapping = (patch: Partial<CsvMapping> = {}): CsvMapping => ({
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
  ...patch,
});

const layouts: ImportMapping[] = [
  {
    signature: 'date|details|amount',
    name: 'pinegrove-checking.csv',
    accountId: checking.id,
    mapping: mapping(),
    updatedAt: '2026-11-03T15:20:00.000Z',
  },
  {
    signature: 'txn date|debit|credit',
    name: 'summit-card.csv',
    accountId: null,
    mapping: mapping({ amountMode: 'debit_credit', skipRows: 2, dateFormat: 'YYYY-MM-DD' }),
    updatedAt: '2026-09-14T08:00:00.000Z',
  },
  {
    signature: 'old|layout',
    name: 'closed-bank.csv',
    accountId: 'acc_gone',
    mapping: mapping(),
    updatedAt: '2026-01-02T08:00:00.000Z',
  },
];

function workerAnswers(...answers: (() => Response)[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  let n = 0;
  http.fetch = jest.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const answer = answers[Math.min(n, answers.length - 1)]!;
    n += 1;
    return answer();
  });
  return calls;
}
const ok = (list: ImportMapping[]) => () =>
  new Response(JSON.stringify({ mappings: list }), { status: 200 });

beforeEach(() => {
  setBackendConfigForTests({ url: 'https://api.demo.test', token: 'demo-token' });
  setFinance(sample);
});
afterEach(() => {
  http.fetch = realFetch;
});

describe('saved file layouts', () => {
  it('lists each layout with its name, account and when it was last used', async () => {
    const calls = workerAnswers(ok(layouts));
    await render(<SavedLayouts />);
    await waitFor(() => expect(screen.getByText('pinegrove-checking.csv')).toBeTruthy());
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.demo.test/v1/import-mappings');
    expect(calls[0]!.init?.method).toBe('GET');

    const meta = (sig: string) => String(screen.getByTestId(`layout-meta-${sig}`).props.children);
    expect(meta('date|details|amount')).toBe(`Into "${checking.name}" · Last used Nov 3`);
    expect(meta('txn date|debit|credit')).toBe('No account saved with it · Last used Sep 14');
    expect(meta('old|layout')).toMatch(/^Into an account not on this device · Last used/);
    // Newest first, as the Worker sends them.
    const names = screen.getAllByText(/\.csv$/).map((n) => n.props.children);
    expect(names).toEqual(['pinegrove-checking.csv', 'summit-card.csv', 'closed-bank.csv']);
    expect(
      screen.getByText(/Removing a saved layout is not possible from the app yet/),
    ).toBeTruthy();
  });

  it('says what the columns are', () => {
    expect(layoutColumnsText(layouts[0]!)).toBe('Dates day first (31/12/2026) · one amount column');
    expect(layoutColumnsText(layouts[1]!)).toBe(
      'Dates year first (2026-12-31) · money out and in in two columns · last file had 2 lines above the header',
    );
    expect(layoutAccountText(null, [])).toBe('No account saved with it');
  });

  it('says when there are none yet', async () => {
    workerAnswers(ok([]));
    await render(<SavedLayouts />);
    await waitFor(() => expect(screen.getByText('No saved layouts yet')).toBeTruthy());
    expect(screen.queryByText(/Removing a saved layout/)).toBeNull();
  });

  it('shows an error and can try again', async () => {
    const calls = workerAnswers(
      () => new Response('{"error":"internal","message":"D1 is not answering."}', { status: 500 }),
      ok(layouts),
    );
    await render(<SavedLayouts />);
    await waitFor(() => expect(screen.getByTestId('saved-layouts-error')).toBeTruthy());
    expect(screen.getByTestId('saved-layouts-error').props.children).toBe('D1 is not answering.');
    await fireEvent.press(screen.getByTestId('saved-layouts-retry'));
    await waitFor(() => expect(screen.getByText('summit-card.csv')).toBeTruthy());
    expect(screen.queryByTestId('saved-layouts-error')).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it('Try again clears the error while it asks', async () => {
    let release!: (r: Response) => void;
    let n = 0;
    http.fetch = jest.fn(() => {
      n += 1;
      if (n === 1)
        return Promise.resolve(new Response('{"error":"internal","message":"x"}', { status: 500 }));
      return new Promise<Response>((r) => (release = r));
    });
    await render(<SavedLayouts />);
    await waitFor(() => expect(screen.getByTestId('saved-layouts-retry')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('saved-layouts-retry'));
    expect(screen.queryByTestId('saved-layouts-error')).toBeNull();
    expect(screen.getByText('Loading...')).toBeTruthy();
    await act(async () => release(ok(layouts)()));
    expect(screen.getByText('summit-card.csv')).toBeTruthy();
  });

  it('loads again for another backend, and drops the old answer', async () => {
    let release!: (r: Response) => void;
    const calls: string[] = [];
    http.fetch = jest.fn((url: string) => {
      calls.push(url);
      if (calls.length === 1) return new Promise<Response>((r) => (release = r));
      return Promise.resolve(ok([layouts[1]!])());
    });
    await render(<SavedLayouts />);
    await act(async () =>
      setBackendConfigForTests({ url: 'https://other.demo.test', token: 'other-token' }),
    );
    await waitFor(() => expect(screen.getByText('summit-card.csv')).toBeTruthy());
    await act(async () => release(ok(layouts)()));
    expect(screen.queryByText('pinegrove-checking.csv')).toBeNull();
    // The dropped answer is not reported as an error either, and the new list stays.
    expect(screen.queryByTestId('saved-layouts-error')).toBeNull();
    expect(screen.getByText('summit-card.csv')).toBeTruthy();
    expect(calls).toEqual([
      'https://api.demo.test/v1/import-mappings',
      'https://other.demo.test/v1/import-mappings',
    ]);
  });

  it('is a tab of the import screen', async () => {
    workerAnswers(ok(layouts));
    await render(<ImportScreen />);
    expect(screen.queryByTestId('saved-layouts')).toBeNull();
    await fireEvent.press(screen.getByText('File layouts'));
    await waitFor(() => expect(screen.getByText('pinegrove-checking.csv')).toBeTruthy());
  });
});
