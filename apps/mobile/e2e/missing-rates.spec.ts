import type { Page } from '@playwright/test';
import { expect, open, test, type WorkerApi } from './fixtures';
import { PLANTED } from './harness/plant';

/**
 * Blocks L, M, O and R: every total that leaves out an amount with no
 * exchange rate says so. The setup planted CHF items, and the local Worker
 * has no CHF rate; each test first reads that back from the Worker.
 */

async function expectNoChfRate(api: WorkerApi) {
  const data = await api.dataset();
  expect(data.fxRates.some((r) => r.base === 'CHF' || r.quote === 'CHF')).toBe(false);
  return data;
}

const line = (page: Page, testId: string) => page.getByTestId(testId).first();

test('Home names the CHF wallet and the CHF expense', async ({ page, api }) => {
  const data = await expectNoChfRate(api);
  expect(data.accounts.find((a) => a.name === PLANTED.chfWallet)?.currency).toBe('CHF');
  expect(data.transactions.find((t) => t.name === PLANTED.chfExpense)?.currency).toBe('CHF');

  await open(page, '/', 'screen-dashboard');
  await expect(line(page, 'net-worth-left-out')).toContainText(PLANTED.chfWallet);
  await expect(line(page, 'spending-no-rate')).toContainText(`"${PLANTED.chfExpense}"`);
  await expect(line(page, 'spending-no-rate')).toContainText('no CHF to USD exchange rate');
});

test('Net worth and Accounts name the CHF wallet (block L)', async ({ page, api }) => {
  await expectNoChfRate(api);
  await open(page, '/networth', 'screen-networth');
  await expect(line(page, 'networth-no-rate')).toContainText(`"${PLANTED.chfWallet}"`);
  await expect(line(page, 'networth-no-rate')).toContainText('no CHF to USD exchange rate');

  await open(page, '/accounts', 'screen-accounts');
  await expect(line(page, 'group-no-rate-Cash')).toContainText(PLANTED.chfWallet);
});

test('Budgets, its Spending plan and the monthly recap (blocks M and O)', async ({ page, api }) => {
  const data = await expectNoChfRate(api);
  const month = new Date().toISOString().slice(0, 7);
  const budget = data.budgets.find(
    (b) => b.categoryId === PLANTED.chfBudgetCategory && b.month === month,
  );
  expect(budget?.currency).toBe('CHF');
  expect(data.recurring.find((r) => r.name === PLANTED.chfBill)?.currency).toBe('CHF');

  await open(page, '/budgets', 'screen-budgets');
  await expect(line(page, 'budget-spending-no-rate')).toContainText(`"${PLANTED.chfExpense}"`);
  await expect(line(page, 'budget-amount-no-rate')).toContainText(
    `The "${PLANTED.chfBudgetName}" budget is in CHF`,
  );

  await page.getByRole('radio', { name: 'Spending plan' }).click();
  await expect(line(page, 'plan-items-no-rate')).toContainText(`"${PLANTED.chfBill}"`);

  await open(page, '/recaps/month', 'screen-recap-monthly');
  await expect(line(page, 'recap-no-rate')).toContainText(`"${PLANTED.chfExpense}"`);
});

test('Recurring names the CHF bill (block M)', async ({ page, api }) => {
  await expectNoChfRate(api);
  await open(page, '/recurring', 'screen-recurring');
  await expect(line(page, 'recurring-no-rate')).toContainText(`"${PLANTED.chfBill}"`);
});

test('Investments names VTI under its totals and the S&P 500 comparison (blocks O and R)', async ({
  page,
  api,
}) => {
  const data = await expectNoChfRate(api);
  const vti = data.securities.find((s) => s.symbol === PLANTED.chfHolding);
  expect(data.holdings.find((h) => h.securityId === vti?.id)?.currency).toBe('CHF');

  await open(page, '/networth/investments', 'screen-investments');
  await expect(line(page, 'invest-holdings-no-rate')).toContainText(`"${PLANTED.chfHolding}"`);
  await expect(line(page, 'bench-no-rate')).toContainText(`"${PLANTED.chfHolding}"`);
  await expect(line(page, 'bench-no-rate')).toContainText('no CHF to USD exchange rate');
});
