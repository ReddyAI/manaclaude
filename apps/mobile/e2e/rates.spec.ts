import { expect, open, test } from './fixtures';
import { PLANTED } from './harness/plant';

/**
 * Block V: Settings, Exchange rates says how far back the Worker's day rates
 * go for each currency in use, when the oldest transaction is older than the
 * oldest rate, and names a currency with no rate at all. Every date is read
 * back from the Worker's own dataset.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const withYear = (d: string) =>
  `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}, ${d.slice(0, 4)}`;

test('rate ranges, the older INR expense and the CHF line', async ({ page, api }) => {
  const data = await api.dataset();
  const inrDates = data.fxRates
    .filter((r) => r.base === 'INR' || r.quote === 'INR')
    .map((r) => r.date)
    .sort();
  const oldestRate = inrDates[0]!;
  const newestRate = inrDates[inrDates.length - 1]!;
  const oldestInr = data.transactions
    .filter((t) => t.currency === 'INR')
    .map((t) => t.date)
    .sort()[0]!;
  expect(data.transactions.some((t) => t.name === PLANTED.oldInrExpense)).toBe(true);
  expect(oldestInr < oldestRate).toBe(true);
  expect(data.fxRates.some((r) => r.base === 'CHF' || r.quote === 'CHF')).toBe(false);

  await open(page, '/settings', 'screen-settings');
  const inr = page.getByTestId('rate-range-INR');
  await expect(inr).toContainText(
    `INR: day rates from ${withYear(oldestRate)} to ${withYear(newestRate)}`,
  );
  await expect(page.getByTestId('rate-range-older-INR')).toContainText(
    `Your oldest INR transaction is from ${withYear(oldestInr)}, before the oldest INR rate, so reports before ${withYear(oldestRate)} use the ${withYear(oldestRate)} rate.`,
  );
  await expect(page.getByTestId('rate-range-CHF')).toContainText(
    'CHF: there is no CHF to USD exchange rate yet, so totals leave out amounts in CHF.',
  );
  // USD is the report currency: it needs no rate of its own and gets no "older" line.
  await expect(page.getByTestId('rate-range-older-USD')).toHaveCount(0);
});
