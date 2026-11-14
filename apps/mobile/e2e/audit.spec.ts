import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { auditPage, type Finding } from './harness/audit';
import { expect, open, test } from './fixtures';

/**
 * Block U's screen-by-screen check: every screen and sheet, in every look and
 * colour scheme, at both widths. Takes a screenshot of each and writes what
 * the in-page checks find to audit.json. Slow, so it runs only on demand:
 *
 *   E2E_AUDIT=1 npm run e2e -w @manaclaude/mobile -- audit
 *
 * It never fails on a finding; it is for a person to read. Checks that must
 * not regress live in the regular suite (layout.spec.ts).
 */
test.skip(!process.env.E2E_AUDIT, 'Set E2E_AUDIT=1 to run the screen audit.');
test.setTimeout(20 * 60_000);

const LOOKS = ['midnight', 'warm', 'compact'] as const;
const SCHEMES = ['light', 'dark'] as const;

interface Ids {
  txn: string;
  cashAccount: string;
}

const SCREENS: [name: string, route: (ids: Ids) => string, testId: string][] = [
  ['home', () => '/', 'screen-dashboard'],
  ['transactions', () => '/transactions', 'screen-transactions'],
  ['transaction', (i) => `/transactions/${i.txn}`, 'screen-transaction'],
  ['review', () => '/transactions/review', 'screen-review'],
  ['transfers', () => '/transactions/transfers', 'screen-possible-transfers'],
  ['receipts', () => '/transactions/receipts', 'screen-receipts-to-attach'],
  ['accounts', () => '/accounts', 'screen-accounts'],
  ['account', () => '/accounts/acc_checking', 'screen-account'],
  ['budgets', () => '/budgets', 'screen-budgets'],
  ['networth', () => '/networth', 'screen-networth'],
  ['investments', () => '/networth/investments', 'screen-investments'],
  ['recurring', () => '/recurring', 'screen-recurring'],
  ['settings', () => '/settings', 'screen-settings'],
  ['planning', () => '/planning', 'screen-planning'],
  ['recap-month', () => '/recaps/month', 'screen-recap-monthly'],
  ['recap-week', () => '/recaps/weekly', 'screen-recap-weekly'],
  ['alerts', () => '/alerts', 'screen-alerts'],
  ['ask', () => '/ask', 'screen-ask'],
  ['assistants', () => '/assistants', 'screen-assistant'],
  ['categories', () => '/categories', 'screen-categories'],
  ['import', () => '/import', 'screen-import'],
  ['link', () => '/link', 'screen-link'],
  ['rules', () => '/rules', 'screen-rules'],
  ['vault', () => '/vault', 'screen-vault'],
];

interface Sheet {
  name: string;
  route: (ids: Ids) => string;
  screen: string;
  sheet: string;
  open: (page: Page, ids: Ids) => Promise<void>;
}

const click = (testId: string) => async (page: Page) => {
  await page.getByTestId(testId).first().click();
};

const SHEETS: Sheet[] = [
  {
    name: 'rate',
    route: () => '/',
    screen: 'screen-dashboard',
    sheet: 'rate-sheet',
    // A tap changes the display currency; the rate sheet needs a long press.
    open: async (p) => {
      await p.getByTestId('currency-chip').first().click({ delay: 900 });
    },
  },
  {
    name: 'cash',
    route: () => '/transactions',
    screen: 'screen-transactions',
    sheet: 'cash-sheet',
    open: click('cash-quick-add'),
  },
  {
    name: 'transaction-detail',
    route: () => '/transactions',
    screen: 'screen-transactions',
    sheet: 'transaction-detail',
    open: (p, i) => click(`txn-${i.txn}`)(p),
  },
  {
    name: 'category-picker',
    route: () => '/transactions',
    screen: 'screen-transactions',
    sheet: 'category-picker',
    open: async (p, i) => {
      await click(`txn-${i.txn}`)(p);
      await click('change-category')(p);
    },
  },
  {
    name: 'edit-transaction',
    route: () => '/transactions',
    screen: 'screen-transactions',
    sheet: 'edit-transaction-sheet',
    open: async (p, i) => {
      await click(`txn-${i.txn}`)(p);
      await click('edit-transaction')(p);
    },
  },
  {
    name: 'link-transfer',
    route: () => '/transactions',
    screen: 'screen-transactions',
    sheet: 'link-sheet',
    open: async (p, i) => {
      await click(`txn-${i.txn}`)(p);
      await click('link-transfer')(p);
    },
  },
  {
    name: 'manual-account',
    route: () => '/accounts',
    screen: 'screen-accounts',
    sheet: 'manual-account-sheet',
    open: async (p) => {
      await p.getByRole('radio', { name: 'Connectors' }).click();
      await click('add-manual-account')(p);
    },
  },
  {
    name: 'cash-account',
    route: () => '/accounts',
    screen: 'screen-accounts',
    sheet: 'cash-account-sheet',
    open: async (p) => {
      await p.getByRole('radio', { name: 'Connectors' }).click();
      await click('add-cash-account')(p);
    },
  },
  {
    name: 'account-edit',
    route: (i) => `/accounts/${i.cashAccount}`,
    screen: 'screen-account',
    sheet: 'account-edit-sheet',
    open: click('account-edit'),
  },
  {
    name: 'account-remove',
    route: (i) => `/accounts/${i.cashAccount}`,
    screen: 'screen-account',
    sheet: 'remove-account-sheet',
    open: click('account-remove'),
  },
  {
    name: 'ai-jobs',
    route: () => '/settings',
    screen: 'screen-settings',
    sheet: 'ai-jobs-sheet',
    open: click('settings-ai-jobs'),
  },
  {
    name: 'budget-edit',
    route: () => '/budgets',
    screen: 'screen-budgets',
    sheet: 'budget-edit-sheet',
    open: click('budget-cat_groceries'),
  },
  {
    name: 'category',
    route: () => '/categories',
    screen: 'screen-categories',
    sheet: 'category-sheet',
    open: click('category-row-cat_coffee'),
  },
  {
    name: 'category-add',
    route: () => '/categories',
    screen: 'screen-categories',
    sheet: 'category-add-sheet',
    open: click('category-add'),
  },
  {
    name: 'recurring',
    route: () => '/recurring',
    screen: 'screen-recurring',
    sheet: 'recurring-sheet',
    open: click('recurring-rec_netflix'),
  },
  {
    name: 'lots',
    route: () => '/networth/investments',
    screen: 'screen-investments',
    sheet: 'lots-sheet',
    open: click('holding-hold_brokerage_aapl'),
  },
];

const outDir = path.join(
  process.env.E2E_OUT_DIR ?? path.join(os.tmpdir(), 'billionaire-e2e-results'),
  'audit',
);

for (const look of LOOKS) {
  for (const scheme of SCHEMES) {
    test(`audit ${look} ${scheme}`, async ({ page, api, errors }, info) => {
      await api.send('PATCH', '/v1/settings', { look, colorScheme: scheme });
      await page.emulateMedia({ colorScheme: scheme });
      const data = await api.dataset();
      const ids: Ids = {
        txn: data.transactions.find((t) => t.amount < 0 && !t.transferLinkId)!.id,
        cashAccount: data.accounts.find((a) => a.type === 'cash' && a.currency === 'CHF')!.id,
      };
      const dir = path.join(outDir, info.project.name, `${look}-${scheme}`);
      fs.mkdirSync(dir, { recursive: true });
      const results: { page: string; findings: Finding[] | 'not opened' }[] = [];

      for (const [name, route, testId] of SCREENS) {
        await open(page, route(ids), testId);
        await page.waitForTimeout(400);
        await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: true });
        results.push({ page: name, findings: await auditPage(page) });
      }
      for (const s of SHEETS) {
        await open(page, s.route(ids), s.screen);
        try {
          await s.open(page, ids);
          const sheet = page.getByTestId(s.sheet).first();
          await expect(sheet).toBeVisible({ timeout: 5_000 });
          await page.waitForTimeout(500);
          await page.screenshot({ path: path.join(dir, `sheet-${s.name}.png`) });
          results.push({ page: `sheet ${s.name}`, findings: await auditPage(page, sheet) });
        } catch {
          results.push({ page: `sheet ${s.name}`, findings: 'not opened' });
        }
      }
      fs.writeFileSync(path.join(dir, 'audit.json'), JSON.stringify(results, null, 2));
      // A broken page is still worth knowing about, but not as a failed audit.
      if (errors.length) fs.writeFileSync(path.join(dir, 'errors.json'), JSON.stringify(errors));
      errors.length = 0;
    });
  }
}
