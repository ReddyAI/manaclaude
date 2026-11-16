import type {
  BankHistoryReviewResponse,
  BankHistoryReviewsResponse,
  HistoryRead,
} from '@manaclaude/shared';
import { expect, open, test } from './fixtures';
import { historyCutoff, PLANTED } from './harness/plant';

/**
 * History sources (Codex's #35 and #36) end to end, on the real local
 * Worker: the bank-review inbox, a cutoff that would split saved history
 * refused and a fitting one saved, then a Monefy file read under it. Every
 * outcome is read back from the Worker. In order: a policy cannot be saved
 * while reviews wait, and the import needs the saved policy.
 */
test.describe.configure({ mode: 'serial' });

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const SHORT = MONTHS.map((m) => m.slice(0, 3));
const longMonth = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]} ${m.slice(0, 4)}`;
const withYear = (d: string) =>
  `${SHORT[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}, ${d.slice(0, 4)}`;
const shift = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const monthsBefore = (date: string, n: number) => {
  const d = new Date(`${date.slice(0, 7)}-01T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString().slice(0, 7);
};
/** Monefy writes day-first dates. */
const dmy = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

test('bank reviews: keep both and skip, read back from the Worker', async ({ page, api }) => {
  const { reviews } = await api.get<BankHistoryReviewsResponse>('/v1/history-policy/bank-reviews');
  expect(reviews.map((r) => r.id).sort()).toEqual([PLANTED.reviewKeep, PLANTED.reviewSkip]);

  await open(page, '/accounts', 'screen-accounts');
  await expect(page.getByTestId('reviews-banner')).toHaveText(
    '2 bank transactions wait for your review',
  );
  await page.getByTestId('reviews-banner-open').click();
  await expect(page.getByTestId('screen-bank-reviews')).toBeVisible();
  await expect(
    page.getByTestId(`review-candidate-${PLANTED.reviewKeep}-${PLANTED.monefyTea}`),
  ).toContainText(PLANTED.monefyTeaName);

  const kept = page.waitForResponse(
    (r) =>
      r.url().endsWith(`/bank-reviews/${PLANTED.reviewKeep}`) && r.request().method() === 'POST',
  );
  await page.getByTestId(`review-keep-${PLANTED.reviewKeep}`).click();
  expect((await kept).status()).toBe(200);
  await expect(page.getByTestId(`review-done-${PLANTED.reviewKeep}`)).toContainText(
    'Kept: the bank transaction is saved next to the Monefy entry',
  );
  const keptBack = await api.get<BankHistoryReviewResponse>(
    `/v1/history-policy/bank-reviews/${PLANTED.reviewKeep}`,
  );
  expect(keptBack.review.status).toBe('kept');

  await page.getByTestId(`review-skip-${PLANTED.reviewSkip}`).click();
  await expect(page.getByTestId(`review-done-${PLANTED.reviewSkip}`)).toContainText(
    'Skipped: this bank transaction is not saved.',
  );
  const skippedBack = await api.get<BankHistoryReviewResponse>(
    `/v1/history-policy/bank-reviews/${PLANTED.reviewSkip}`,
  );
  expect(skippedBack.review.status).toBe('skipped');
  await expect(page.getByTestId('reviews-empty')).toBeVisible();

  const data = await api.dataset();
  expect(data.transactions.find((t) => t.id === PLANTED.bankTeaKeep)?.source).toBe('connector');
  expect(data.transactions.some((t) => t.id === PLANTED.bankTeaSkip)).toBe(false);
  expect(data.transactions.find((t) => t.id === PLANTED.monefyTea)?.name).toBe(
    PLANTED.monefyTeaName,
  );
});

test('history sources: a splitting cutoff is refused, a fitting one is saved', async ({
  page,
  api,
}) => {
  const before = await api.get<HistoryRead>('/v1/history-policy');
  expect(before.version).toBe(0);
  const cutoff = historyCutoff(await api.dataset());
  const month = monthsBefore(cutoff, 2);

  await open(page, '/settings', 'screen-settings');
  await page.getByTestId('settings-history').click();
  await expect(page.getByTestId('screen-history')).toBeVisible();
  await expect(page.getByTestId('history-version')).toContainText('No cutoff is saved yet');

  // Forty-five days later: the seeded bank rows before it would fall on Monefy's side.
  await page.getByTestId('history-cutoff').fill(shift(cutoff, 45));
  await page.getByTestId('history-check-button').click();
  await expect(page.getByTestId('history-check-headline')).toHaveText(
    'These settings cannot be saved yet',
  );
  await expect(page.getByTestId('history-conflict').first()).toContainText(
    'on dates Monefy would own',
  );
  await expect(page.getByTestId('history-save')).toHaveCount(0);
  expect((await api.get<HistoryRead>('/v1/history-policy')).version).toBe(0);

  await page.getByTestId('history-cutoff').fill(cutoff);
  await page.getByTestId(`history-month-acc_checking-${month}`).click();
  await page.getByTestId('history-check-button').click();
  await expect(page.getByTestId('history-check-headline')).toHaveText('Ready to save');
  await page.getByTestId('history-save').click();
  await expect(page.getByTestId('history-saved')).toContainText('Saved.');

  const after = await api.get<HistoryRead>('/v1/history-policy');
  expect(after.version).toBe(1);
  expect(after.policy).toEqual({
    defaultCutoff: cutoff,
    accounts: [{ accountId: 'acc_checking', mode: 'default', replacementMonths: [month] }],
  });
  const periods = page.getByTestId('history-periods-acc_checking');
  await expect(periods).toContainText(`Bank, all of ${longMonth(month)}`);
  await expect(periods).toContainText(`Bank from ${withYear(cutoff)}`);
});

test('a Monefy file leaves out the rows the bank owns', async ({ page, api }) => {
  const cutoff = historyCutoff(await api.dataset());
  const month = monthsBefore(cutoff, 2);
  const keptDate = shift(cutoff, -15);
  const csv = [
    'date,account,category,amount,currency,converted amount,currency,description',
    `${dmy(keptDate)},E2E Card,Groceries,-21.50,USD,-21.50,USD,E2E Monefy kept`,
    `${dmy(`${month}-15`)},E2E Card,Groceries,-30.00,USD,-30.00,USD,E2E Monefy replaced month`,
    `${dmy(shift(cutoff, 15))},E2E Card,Groceries,-40.00,USD,-40.00,USD,E2E Monefy after cutoff`,
    '',
  ].join('\n');

  await open(page, '/import', 'screen-import');
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('import-pick').click();
  await (
    await chooser
  ).setFiles({
    name: 'e2e-monefy.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csv),
  });
  await page.getByTestId('import-preview').click();
  await page.getByTestId('import-source-0-acc_checking').click();
  await page.getByTestId('import-preview').click();

  await expect(page.getByTestId('import-policy-excluded')).toContainText(
    '2 rows are left out by History sources',
  );
  await page.getByTestId('import-policy-toggle').click();
  await expect(page.getByTestId('import-policy-row-3')).toContainText('a month the bank replaces');
  await expect(page.getByTestId('import-policy-row-4')).toContainText(
    'on or after the bank cutoff',
  );

  const committed = page.waitForResponse((r) =>
    /\/v1\/imports\/[^/]+\/commit$/.test(new URL(r.url()).pathname),
  );
  await page.getByTestId('import-confirm').click();
  const answer = (await (await committed).json()) as { added: number; policyExcluded?: number };
  expect(answer).toMatchObject({ added: 1, policyExcluded: 2 });
  await expect(page.getByTestId('import-result')).toContainText('(2 of them by History sources)');

  const data = await api.dataset();
  const fromFile = data.transactions.filter(
    (t) =>
      t.accountId === 'acc_checking' &&
      t.externalId?.startsWith('monefy:') &&
      t.id !== PLANTED.monefyTea,
  );
  expect(fromFile.map((t) => [t.date, t.amount])).toEqual([[keptDate, -2_150]]);
});
