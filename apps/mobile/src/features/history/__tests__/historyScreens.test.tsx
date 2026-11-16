import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ReactElement } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import type {
  BankHistoryReview,
  HistoryPolicy,
  HistoryRead,
  PolicyPreview,
  Transaction,
} from '@manaclaude/shared';
import { createSampleData } from '@manaclaude/shared/sample';
import { setBackendConfigForTests } from '../../../data/backend/config';
import { fakeBackend, json, settle } from '../../../data/backend/__tests__/helpers';
import { setFinance } from '../../../data/store';
import { syncHistoryText, syncUntilDone } from '../../link/linkApi';
import { BankReviewsScreen } from '../BankReviewsScreen';
import { bankReviewsStore, historyStore } from '../historyApi';
import { HistorySourcesScreen } from '../HistorySourcesScreen';
import { ReviewsBanner } from '../ReviewsBanner';
import { PolicyExcludedSection } from '../../import/PolicyExcludedSection';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), navigate: jest.fn(), back: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({}),
}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));
jest.mock('../../../design/haptics', () => ({
  ...jest.requireActual('../../../design/haptics'),
  haptic: jest.fn(),
}));
jest.mock('../../../data/backend/sync', () => ({
  ...jest.requireActual('../../../data/backend/sync'),
  refreshDataset: jest.fn(async () => {}),
}));

/** History sources and bank reviews against a fake Worker. Invented data only. */

const inRoot = (ui: ReactElement) => <GestureHandlerRootView>{ui}</GestureHandlerRootView>;
const sample = createSampleData({ today: '2026-11-05' });
const TOKEN = 'a'.repeat(64);
const TOKEN2 = 'b'.repeat(64);

const read = (version: number, policy: HistoryPolicy): HistoryRead => ({
  version,
  policy,
  accounts: [
    {
      accountId: 'acc_checking',
      effective: policy.defaultCutoff
        ? { cutoff: policy.defaultCutoff, replacementMonths: [], origin: 'default' }
        : null,
      periods: policy.defaultCutoff
        ? [
            { source: 'monefy', from: null, to: '2026-06-30' },
            { source: 'bank', from: policy.defaultCutoff, to: null },
          ]
        : [{ source: 'independent', from: null, to: null }],
      coverage: { status: 'unknown', complete: false, message: 'Not established.' },
    },
  ],
});
const EMPTY = { defaultCutoff: null, accounts: [] };

function preview(policy: HistoryPolicy, patch: Partial<PolicyPreview> = {}): PolicyPreview {
  return {
    expectedVersion: 0,
    policy,
    previewToken: TOKEN,
    allowed: true,
    conflicts: [],
    boundaryCandidates: [],
    pendingBankReviews: 0,
    accounts: read(0, policy).accounts,
    warnings: ['Each selected replacement month replaces the entire account/month.'],
    ...patch,
  };
}

let backend: ReturnType<typeof fakeBackend>;

beforeEach(async () => {
  historyStore.reset();
  bankReviewsStore.reset();
  await act(() => {
    setFinance(sample);
    setBackendConfigForTests({ url: 'https://api.demo.test', token: 'demo-token' });
  });
});
afterEach(() => backend?.restore());

const press = async (id: string) => {
  await fireEvent.press(screen.getByTestId(id));
  await act(() => settle());
};
const type = async (id: string, text: string) => {
  await fireEvent.changeText(screen.getByTestId(id), text);
};

describe('History sources', () => {
  it('says when no cutoff is saved, and refuses to ask the Worker without a real date', async () => {
    backend = fakeBackend({
      'GET /v1/history-policy': () => json(200, read(0, EMPTY)),
      'GET /v1/history-policy/bank-reviews': () => json(200, { reviews: [] }),
    });
    await render(inRoot(<HistorySourcesScreen />));
    await waitFor(() => expect(screen.getByTestId('history-version')).toBeTruthy());
    expect(screen.getByTestId('history-version')).toHaveTextContent(/No cutoff is saved yet/);
    await type('history-cutoff', '2026-13-01');
    await press('history-check-button');
    expect(screen.getByTestId('history-problem')).toHaveTextContent(/Enter the cutoff as a date/);
    expect(backend.sent('POST /v1/history-policy/preview')).toHaveLength(0);
  });

  it('shows what blocks a change, with the import to undo, and offers no Save', async () => {
    backend = fakeBackend({
      'GET /v1/history-policy': () => json(200, read(0, EMPTY)),
      'GET /v1/history-policy/bank-reviews': () => json(200, { reviews: [] }),
      'GET /v1/imports': () => json(200, { imports: [{ id: 'imp_m', fileName: 'monefy.csv' }] }),
      'POST /v1/history-policy/preview': (c) =>
        json(
          200,
          preview((c.body as { policy: HistoryPolicy }).policy, {
            allowed: false,
            conflicts: [
              {
                accountId: 'acc_checking',
                transactionId: sample.transactions.find((t) => t.accountId === 'acc_checking')!.id,
                importId: 'imp_m',
                reason: 'monefy_in_bank_period',
              },
              {
                accountId: 'acc_checking',
                transactionId: 'txn_other_import',
                importId: 'imp_other',
                reason: 'monefy_in_bank_period',
              },
              {
                accountId: 'acc_savings',
                transactionId: 'txn_unknown',
                importId: null,
                reason: 'bank_in_monefy_period',
              },
            ],
            pendingBankReviews: 2,
          }),
        ),
    });
    await render(inRoot(<HistorySourcesScreen />));
    await waitFor(() => expect(screen.getByTestId('history-cutoff')).toBeTruthy());
    await type('history-cutoff', '2026-07-01');
    await press('history-check-button');
    await waitFor(() => expect(screen.getByTestId('history-check')).toBeTruthy());
    expect(backend.sent('POST /v1/history-policy/preview')[0]!.body).toEqual({
      policy: { defaultCutoff: '2026-07-01', accounts: [] },
    });
    expect(screen.getByTestId('history-check-headline')).toHaveTextContent(
      'These settings cannot be saved yet',
    );
    await waitFor(() =>
      expect(screen.getAllByTestId('history-conflict')[0]).toHaveTextContent(
        /the import "monefy.csv"/,
      ),
    );
    // One line per import: undoing one import does not fix the other's rows.
    expect(screen.getAllByTestId('history-conflict')[1]).toHaveTextContent(/from an import\./);
    expect(screen.getAllByTestId('history-conflict')[2]).toHaveTextContent(
      /1 bank transaction in "High-Yield Savings" falls on dates Monefy would own/,
    );
    expect(screen.getByTestId('history-pending-reviews')).toHaveTextContent(
      /2 bank transactions wait/,
    );
    expect(screen.queryByTestId('history-save')).toBeNull();
  });

  it('saves exactly what the Worker checked, and an edit throws the check away', async () => {
    const sent: HistoryPolicy = {
      defaultCutoff: '2026-07-01',
      accounts: [{ accountId: 'acc_checking', mode: 'default', replacementMonths: ['2026-05'] }],
    };
    // The Worker answers with its own normalized form; that is what gets saved.
    const normalized: HistoryPolicy = {
      ...sent,
      accounts: [
        ...sent.accounts,
        { accountId: 'acc_savings', mode: 'default', replacementMonths: [] },
      ],
    };
    backend = fakeBackend({
      'GET /v1/history-policy': () => json(200, read(0, EMPTY)),
      'GET /v1/history-policy/bank-reviews': () => json(200, { reviews: [] }),
      'POST /v1/history-policy/preview': () =>
        json(200, preview(normalized, { expectedVersion: 0 })),
      'PUT /v1/history-policy': () => json(200, { ...read(1, normalized), replayed: false }),
    });
    await render(inRoot(<HistorySourcesScreen />));
    await waitFor(() => expect(screen.getByTestId('history-cutoff')).toBeTruthy());
    await type('history-cutoff', '2026-07-01');
    await press('history-month-acc_checking-2026-05');
    await press('history-check-button');
    expect(backend.sent('POST /v1/history-policy/preview')[0]!.body).toEqual({ policy: sent });
    expect(screen.getByTestId('history-check-headline')).toHaveTextContent('Ready to save');

    // An edit after the check: Save goes until it is checked again.
    await press('history-month-acc_checking-2026-04');
    expect(screen.queryByTestId('history-save')).toBeNull();
    await press('history-month-acc_checking-2026-04');
    await press('history-check-button');
    await press('history-save');
    expect(backend.sent('PUT /v1/history-policy')[0]!.body).toEqual({
      policy: normalized,
      expectedVersion: 0,
      previewToken: TOKEN,
    });
    expect(screen.getByTestId('history-saved')).toHaveTextContent(/^Saved\./);
    expect(historyStore.get().value?.version).toBe(1);
    expect(screen.getByTestId('history-version')).toHaveTextContent(
      'Saved: the bank owns from Jul 1, 2026.',
    );
  });

  it('never refreshes a stale check and sends it again on its own', async () => {
    const policy = { defaultCutoff: '2026-07-01', accounts: [] };
    backend = fakeBackend({
      'GET /v1/history-policy': () => json(200, read(0, EMPTY)),
      'GET /v1/history-policy/bank-reviews': () => json(200, { reviews: [] }),
      'POST /v1/history-policy/preview': () => json(200, preview(policy)),
      'PUT /v1/history-policy': () =>
        json(409, { error: 'history_policy_changed', message: 'Review again.' }),
    });
    await render(inRoot(<HistorySourcesScreen />));
    await waitFor(() => expect(screen.getByTestId('history-cutoff')).toBeTruthy());
    await type('history-cutoff', '2026-07-01');
    await press('history-check-button');
    await press('history-save');
    expect(screen.getByTestId('history-changed')).toHaveTextContent(/nothing was saved/);
    expect(backend.sent('PUT /v1/history-policy')).toHaveLength(1);
    expect(backend.sent('POST /v1/history-policy/preview')).toHaveLength(1);
    expect(screen.queryByTestId('history-save')).toBeNull();
  });

  it("on a transition conflict, shows the Worker's own list of what blocks it", async () => {
    const policy = { defaultCutoff: '2026-07-01', accounts: [] };
    let checks = 0;
    backend = fakeBackend({
      'GET /v1/history-policy': () => json(200, read(0, EMPTY)),
      'GET /v1/history-policy/bank-reviews': () => json(200, { reviews: [] }),
      'POST /v1/history-policy/preview': () => {
        checks += 1;
        return json(
          200,
          checks === 1
            ? preview(policy)
            : preview(policy, {
                allowed: false,
                boundaryCandidates: [
                  { bankTransactionId: 'txn_b', monefyTransactionIds: ['txn_m'] },
                ],
              }),
        );
      },
      'PUT /v1/history-policy': () =>
        json(409, { error: 'history_transition_conflict', message: 'History refuses it.' }),
    });
    await render(inRoot(<HistorySourcesScreen />));
    await waitFor(() => expect(screen.getByTestId('history-cutoff')).toBeTruthy());
    await type('history-cutoff', '2026-07-01');
    await press('history-check-button');
    await press('history-save');
    await waitFor(() => expect(screen.getByTestId('history-boundary')).toBeTruthy());
    expect(screen.getByTestId('history-check-headline')).toHaveTextContent(/cannot be saved yet/);
    expect(backend.sent('PUT /v1/history-policy')).toHaveLength(1);
  });

  it('after a lost answer, Try again sends the identical request and the Worker says it was saved', async () => {
    const policy = { defaultCutoff: '2026-07-01', accounts: [] };
    let puts = 0;
    backend = fakeBackend({
      'GET /v1/history-policy': () => json(200, read(0, EMPTY)),
      'GET /v1/history-policy/bank-reviews': () => json(200, { reviews: [] }),
      'POST /v1/history-policy/preview': () => json(200, preview(policy)),
      'PUT /v1/history-policy': () => {
        puts += 1;
        return puts === 1
          ? json(502, { error: 'internal', message: 'Bad gateway.' })
          : json(200, { ...read(1, policy), replayed: true });
      },
    });
    await render(inRoot(<HistorySourcesScreen />));
    await waitFor(() => expect(screen.getByTestId('history-cutoff')).toBeTruthy());
    await type('history-cutoff', '2026-07-01');
    await press('history-check-button');
    await press('history-save');
    expect(screen.getByTestId('history-unsure')).toBeTruthy();
    await press('history-retry-save');
    const [first, second] = backend.sent('PUT /v1/history-policy');
    expect(second!.body).toEqual(first!.body);
    expect(screen.getByTestId('history-saved')).toHaveTextContent(
      /already been saved by your first try/,
    );
    expect(screen.queryByTestId('history-unsure')).toBeNull();
  });

  it('lists every month by source, gaps included', async () => {
    const t = sample.transactions[0]!;
    await act(() =>
      setFinance({
        ...sample,
        transactions: [
          { ...t, id: 'm1', date: '2026-03-04', source: 'import', externalId: 'monefy:1' },
          { ...t, id: 'b1', date: '2026-01-04', source: 'connector', externalId: 'x' },
        ] as Transaction[],
      }),
    );
    backend = fakeBackend({
      'GET /v1/history-policy': () => json(200, read(0, EMPTY)),
      'GET /v1/history-policy/bank-reviews': () => json(200, { reviews: [] }),
    });
    await render(inRoot(<HistorySourcesScreen />));
    await waitFor(() => expect(screen.getByTestId('history-coverage-2026-03')).toBeTruthy());
    expect(screen.getByTestId('history-coverage-2026-03')).toHaveTextContent(
      /1 Monefy · 0 bank · 0 other/,
    );
    expect(screen.getByTestId('history-coverage-2026-02')).toHaveTextContent(
      /0 Monefy · 0 bank · 0 other/,
    );
    expect(screen.getByTestId('history-coverage-2026-01')).toHaveTextContent(
      /0 Monefy · 1 bank · 0 other/,
    );
  });
});

const tea = (patch: Partial<Transaction>): Transaction => ({
  ...sample.transactions.find((t) => t.accountId === 'acc_checking')!,
  amount: -1_234,
  currency: 'USD',
  ...patch,
});
const review = (id: string, patch: Partial<BankHistoryReview> = {}): BankHistoryReview => ({
  id,
  status: 'pending',
  transaction: tea({ id: `txn_${id}`, name: 'Bank tea', date: '2026-07-02', source: 'connector' }),
  existingTransaction: null,
  candidates: [tea({ id: 'txn_monefy', name: 'Monefy tea', date: '2026-06-30', source: 'import' })],
  eligible: true,
  previewToken: TOKEN,
  ...patch,
});

describe('Bank reviews', () => {
  it("keeps both with the review's own token, reads the list again, and says what happened", async () => {
    let pending = [review('r1'), review('r2', { previewToken: TOKEN2 })];
    backend = fakeBackend({
      'GET /v1/history-policy/bank-reviews': () => json(200, { reviews: pending }),
      'GET /v1/history-policy': () =>
        json(200, read(1, { defaultCutoff: '2026-07-01', accounts: [] })),
      'POST /v1/history-policy/bank-reviews/r1': () => {
        pending = pending.filter((r) => r.id !== 'r1');
        return json(200, { id: 'r1', decision: 'keep', transactionId: 'txn_r1', replayed: false });
      },
    });
    await render(inRoot(<BankReviewsScreen />));
    await waitFor(() => expect(screen.getByTestId('review-r1')).toBeTruthy());
    expect(screen.getByTestId('review-candidate-r1-txn_monefy')).toHaveTextContent(/Monefy tea/);
    await press('review-keep-r1');
    expect(backend.sent('POST /v1/history-policy/bank-reviews/r1')[0]!.body).toEqual({
      previewToken: TOKEN,
      decision: 'keep',
    });
    await waitFor(() => expect(screen.queryByTestId('review-r1')).toBeNull());
    expect(screen.getByTestId('review-done-r1')).toHaveTextContent(
      'Kept: the bank transaction is saved next to the Monefy entry. Nothing was merged.',
    );
    expect(backend.sent('GET /v1/history-policy/bank-reviews').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByTestId('review-r2')).toBeTruthy();
  });

  it('a correction: skipping keeps the saved bank transaction, and keep is off when not allowed', async () => {
    const correction = review('r3', {
      existingTransaction: tea({ id: 'txn_saved', name: 'Bank tea (old)', source: 'connector' }),
      eligible: false,
    });
    let pending = [correction];
    backend = fakeBackend({
      'GET /v1/history-policy/bank-reviews': () => json(200, { reviews: pending }),
      'GET /v1/history-policy': () =>
        json(200, read(1, { defaultCutoff: '2026-07-01', accounts: [] })),
      'POST /v1/history-policy/bank-reviews/r3': () => {
        pending = [];
        return json(200, { id: 'r3', decision: 'skip', transactionId: null, replayed: false });
      },
    });
    await render(inRoot(<BankReviewsScreen />));
    await waitFor(() => expect(screen.getByTestId('review-r3')).toBeTruthy());
    expect(screen.getByTestId('review-existing-r3')).toHaveTextContent(/Bank tea \(old\)/);
    expect(screen.getByTestId('review-not-eligible-r3')).toBeTruthy();
    expect(screen.getByTestId('review-keep-r3')).toBeDisabled();
    expect(screen.getByTestId('review-skip-r3')).toHaveTextContent('Skip this change');
    await press('review-skip-r3');
    await waitFor(() => expect(screen.getByTestId('review-done-r3')).toBeTruthy());
    expect(screen.getByTestId('review-done-r3')).toHaveTextContent(
      'Skipped: the saved bank transaction stays as it was.',
    );
  });

  it('a lost answer: reads the review back, and Try again sends the same decision', async () => {
    let posts = 0;
    let pending = [review('r4')];
    backend = fakeBackend({
      'GET /v1/history-policy/bank-reviews': () => json(200, { reviews: pending }),
      'GET /v1/history-policy': () =>
        json(200, read(1, { defaultCutoff: '2026-07-01', accounts: [] })),
      'GET /v1/history-policy/bank-reviews/r4': () => json(200, { review: review('r4') }),
      'POST /v1/history-policy/bank-reviews/r4': () => {
        posts += 1;
        if (posts === 1) return json(503, { error: 'internal', message: 'Unavailable.' });
        pending = [];
        return json(200, { id: 'r4', decision: 'skip', transactionId: null, replayed: true });
      },
    });
    await render(inRoot(<BankReviewsScreen />));
    await waitFor(() => expect(screen.getByTestId('review-r4')).toBeTruthy());
    await press('review-skip-r4');
    expect(backend.sent('GET /v1/history-policy/bank-reviews/r4')).toHaveLength(1);
    expect(screen.getByTestId('review-note-r4')).toHaveTextContent(/still waiting/);
    expect(screen.queryByTestId('review-keep-r4')).toBeNull();
    await press('review-retry-r4');
    const [a, b] = backend.sent('POST /v1/history-policy/bank-reviews/r4');
    expect(b!.body).toEqual(a!.body);
    await waitFor(() => expect(screen.getByTestId('review-done-r4')).toBeTruthy());
    expect(screen.getByTestId('review-done-r4')).toHaveTextContent(
      /Your first try had already done it/,
    );
  });

  it('already resolved elsewhere: shows what was decided', async () => {
    let pending = [review('r5')];
    backend = fakeBackend({
      'GET /v1/history-policy/bank-reviews': () => json(200, { reviews: pending }),
      'GET /v1/history-policy': () =>
        json(200, read(1, { defaultCutoff: '2026-07-01', accounts: [] })),
      'GET /v1/history-policy/bank-reviews/r5': () =>
        json(200, { review: review('r5', { status: 'kept' }) }),
      'POST /v1/history-policy/bank-reviews/r5': () => {
        pending = [];
        return json(409, { error: 'history_review_resolved', message: 'Resolved.' });
      },
    });
    await render(inRoot(<BankReviewsScreen />));
    await waitFor(() => expect(screen.getByTestId('review-r5')).toBeTruthy());
    await press('review-skip-r5');
    await waitFor(() => expect(screen.getByTestId('review-done-r5')).toBeTruthy());
    expect(screen.getByTestId('review-done-r5')).toHaveTextContent(/^Kept:/);
  });

  it('a change since it was shown: nothing saved, the list read again, no second send', async () => {
    backend = fakeBackend({
      'GET /v1/history-policy/bank-reviews': () =>
        json(200, { reviews: [review('r6', { previewToken: TOKEN2 })] }),
      'GET /v1/history-policy': () =>
        json(200, read(1, { defaultCutoff: '2026-07-01', accounts: [] })),
      'POST /v1/history-policy/bank-reviews/r6': () =>
        json(409, { error: 'history_policy_changed', message: 'Changed.' }),
    });
    await render(inRoot(<BankReviewsScreen />));
    await waitFor(() => expect(screen.getByTestId('review-r6')).toBeTruthy());
    await press('review-keep-r6');
    expect(screen.getByTestId('review-note-r6')).toHaveTextContent(/nothing was saved/);
    expect(backend.sent('POST /v1/history-policy/bank-reviews/r6')).toHaveLength(1);
    expect(backend.sent('GET /v1/history-policy/bank-reviews').length).toBeGreaterThanOrEqual(2);
  });

  it('says when there is nothing to review', async () => {
    backend = fakeBackend({
      'GET /v1/history-policy/bank-reviews': () => json(200, { reviews: [] }),
    });
    await render(inRoot(<BankReviewsScreen />));
    await waitFor(() => expect(screen.getByTestId('reviews-empty')).toBeTruthy());
  });
});

describe('after a sync, and elsewhere', () => {
  it('adds up what History sources left out over every part, and keeps the last review count', async () => {
    let call = 0;
    const part = (more: boolean, excluded: number, pendingReview: number) => ({
      connectionId: 'c1',
      connectorId: 'simplefin',
      outcome: 'ok',
      more,
      status: 'healthy',
      error: null,
      summary: {
        accountsCreated: 0,
        inserted: 3,
        updated: 0,
        removed: 0,
        remaining: more ? 5 : 0,
        more,
        historyPolicy: {
          version: 1,
          excluded,
          pendingReview,
          skippedByReview: 0,
          coverage: 'unknown',
        },
      },
    });
    backend = fakeBackend({
      'POST /v1/connections/c1/sync': () => {
        call += 1;
        return json(200, call === 1 ? part(true, 4, 1) : part(false, 2, 3));
      },
    });
    const report = await syncUntilDone('c1');
    expect(report.history).toEqual({ excluded: 6, pendingReview: 3 });
    expect(syncHistoryText(report)).toBe(
      '6 bank transactions were left out because Monefy owns those dates (History sources). 3 bank transactions look like a Monefy entry you have and wait for your review; they are not saved until you decide.',
    );
  });

  it('says nothing about History sources for a Worker without them', async () => {
    backend = fakeBackend({
      'POST /v1/connections/c1/sync': () =>
        json(200, {
          connectionId: 'c1',
          connectorId: 'simplefin',
          outcome: 'ok',
          more: false,
          status: 'healthy',
          error: null,
          summary: {
            accountsCreated: 0,
            inserted: 1,
            updated: 0,
            removed: 0,
            remaining: 0,
            more: false,
          },
        }),
    });
    const report = await syncUntilDone('c1');
    expect(report.history).toBeNull();
    expect(syncHistoryText(report)).toBeNull();
  });

  it('the banner shows waiting reviews, and nothing when there are none', async () => {
    let reviews = [review('r7')];
    backend = fakeBackend({
      'GET /v1/history-policy/bank-reviews': () => json(200, { reviews }),
    });
    await render(inRoot(<ReviewsBanner />));
    await waitFor(() => expect(screen.getByTestId('reviews-banner')).toBeTruthy());
    expect(screen.getByTestId('reviews-banner')).toHaveTextContent(
      '1 bank transaction waits for your review',
    );
    reviews = [];
    await act(() => bankReviewsStore.load());
    expect(screen.queryByTestId('reviews-banner')).toBeNull();
  });

  it('an import with nothing left out by History sources says nothing about them', async () => {
    const base = {
      importId: 'imp_1',
      format: 'csv' as const,
      status: 'preview' as const,
      fileName: 'm.csv',
      accountId: null,
      rows: [],
      accountsToCreate: [],
      errors: [],
      warnings: [],
      counts: { total: 0, new: 0, alreadyImported: 0, existing: 0, needsAccount: 0 },
      csv: null,
      mapping: null,
      statementCheck: null,
      periodStart: null,
      periodEnd: null,
      historyPolicy: {
        version: 2,
        excludedCount: 0,
        excludedRows: [],
        excludedTotals: [],
        accounts: [],
      },
    };
    await render(inRoot(<PolicyExcludedSection preview={base} accounts={sample.accounts} />));
    expect(screen.queryByTestId('import-policy')).toBeNull();
  });
});
