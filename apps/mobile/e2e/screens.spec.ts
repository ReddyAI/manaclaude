import { expect, open, test } from './fixtures';

/** Every main screen loads from the Worker without a page or console error. */
const SCREENS: [name: string, route: string, testId: string][] = [
  ['Home', '/', 'screen-dashboard'],
  ['Transactions', '/transactions', 'screen-transactions'],
  ['Accounts', '/accounts', 'screen-accounts'],
  ['Budgets', '/budgets', 'screen-budgets'],
  ['Net worth', '/networth', 'screen-networth'],
  ['Investments', '/networth/investments', 'screen-investments'],
  ['Recurring', '/recurring', 'screen-recurring'],
  ['Settings', '/settings', 'screen-settings'],
  ['Planning', '/planning', 'screen-planning'],
];

for (const [name, route, testId] of SCREENS) {
  test(`${name} loads`, async ({ page }) => {
    await open(page, route, testId);
    await expect(page.getByTestId(testId).first()).toBeVisible();
  });
}
