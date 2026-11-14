import type { AiJobResponse, ImportMappingsResponse, MatchRunResponse } from '@manaclaude/shared';
import { expect, open, test } from './fixtures';
import { PLANTED } from './harness/plant';

/**
 * Things the app asks the Worker to do, each read back from the Worker's own
 * API afterwards. Serial: the CSV import at the end runs the Worker's
 * transfer matcher, so it must come after "Look for transfers now".
 */
test.describe.configure({ mode: 'serial' });

test('Add an account by hand', async ({ page, api }) => {
  const name = 'E2E family car';
  await open(page, '/accounts', 'screen-accounts');
  await page.getByRole('radio', { name: 'Connectors' }).click();
  await page.getByTestId('add-manual-account').click();
  const sheet = page.getByTestId('manual-account-sheet');
  await expect(sheet).toBeVisible();

  await sheet.getByTestId('new-account-name').fill(name);
  await sheet.getByTestId('new-account-type-vehicle').click();
  await sheet.getByTestId('new-account-currency-INR').click();
  await sheet.getByTestId('new-account-balance-known').click();
  await sheet.getByTestId('new-account-balance').fill('650000');
  const created = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/v1/accounts/manual' && r.request().method() === 'POST',
  );
  await sheet.getByTestId('new-account-create').click();
  expect((await created).status()).toBe(201);
  await expect(sheet.getByTestId('manual-account-made')).toBeVisible();

  const data = await api.dataset();
  const made = data.accounts.filter((a) => a.name === name);
  expect(made).toHaveLength(1);
  expect(made[0]).toMatchObject({ type: 'vehicle', currency: 'INR', balance: 65_000_000 });

  await sheet.getByTestId('manual-account-done').click();
  await page.getByRole('radio', { name: 'Accounts' }).click();
  await expect(page.getByTestId(`account-${made[0]?.id}`)).toBeVisible();
});

test('Look for transfers now links the planted pair', async ({ page, api }) => {
  const before = await api.dataset();
  for (const id of [PLANTED.transferOut, PLANTED.transferIn]) {
    expect(before.transactions.find((t) => t.id === id)?.transferLinkId ?? null).toBeNull();
  }

  await open(page, '/transactions/transfers', 'screen-possible-transfers');
  const ran = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/v1/transfer-links/run' && r.status() === 200,
  );
  await page.getByTestId('find-transfers').click();
  const answer = (await (await ran).json()) as MatchRunResponse;
  expect(answer.linked).toBeGreaterThanOrEqual(1);
  await expect(page.getByTestId('find-transfers-result')).toContainText(
    answer.linked === 1 ? 'Linked 1 transfer' : `Linked ${answer.linked} transfers`,
  );

  const after = await api.dataset();
  const out = after.transactions.find((t) => t.id === PLANTED.transferOut);
  const into = after.transactions.find((t) => t.id === PLANTED.transferIn);
  expect(out?.transferLinkId).toBeTruthy();
  expect(out?.transferLinkId).toBe(into?.transferLinkId);

  // A second run finds nothing new.
  const again = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/v1/transfer-links/run' && r.status() === 200,
  );
  await page.getByTestId('find-transfers').click();
  expect(((await (await again).json()) as MatchRunResponse).linked).toBe(0);
  await expect(page.getByTestId('find-transfers-result')).toContainText('No new transfers found');
});

test('Run AI jobs now shows what the Worker did', async ({ page, api }) => {
  await open(page, '/settings', 'screen-settings');
  await page.getByTestId('settings-ai-jobs').click();
  await expect(page.getByTestId('ai-jobs-sheet')).toBeVisible();

  const ran = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/v1/ai/jobs/recurring' && r.status() === 200,
  );
  await page.getByTestId('ai-job-run-recurring').click();
  const answer = (await (await ran).json()) as AiJobResponse;
  const result = page.getByTestId('ai-job-result-recurring');
  await expect(result).toContainText(
    answer.changed === 0
      ? 'Nothing needed changing'
      : `${answer.changed} ${answer.changed === 1 ? 'item' : 'items'} changed or added`,
  );

  const alertsRan = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/v1/ai/jobs/alerts' && r.status() === 200,
  );
  const alertsRead = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/v1/alerts' && r.request().method() === 'GET',
  );
  await page.getByTestId('ai-job-run-alerts').click();
  await alertsRan;
  expect((await alertsRead).status()).toBe(200);
  await expect(page.getByTestId('ai-job-result-alerts')).toContainText('Done.');

  // The Worker keeps what the job found.
  const { recurring } = await api.get<{ recurring: unknown[] }>('/v1/recurring');
  expect(recurring.length).toBeGreaterThan(0);
});

test('File layouts lists a layout the Worker saved', async ({ page, api, backend, request }) => {
  await open(page, '/import', 'screen-import');
  await page.getByRole('radio', { name: 'File layouts' }).click();
  await expect(page.getByText('No saved layouts yet')).toBeVisible();

  // An invented bank CSV, imported and saved through the Worker's API.
  const csv = [
    'Bank export',
    'Account: invented',
    'Date,Description,Amount',
    '2026-10-02,E2E Corner Bakery,-12.50',
    '2026-10-03,E2E Book Shop,-30.00',
    '',
  ].join('\n');
  const res = await request.post(`${backend.url}/v1/imports`, {
    headers: { authorization: `Bearer ${backend.token}` },
    multipart: {
      file: { name: 'e2e-bank.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) },
      accountId: 'acc_checking',
      skipRows: '2',
      commit: 'true',
    },
  });
  expect(res.status(), await res.text()).toBe(201);

  const { mappings } = await api.get<ImportMappingsResponse>('/v1/import-mappings');
  expect(mappings).toHaveLength(1);
  const saved = mappings[0]!;
  expect(saved.accountId).toBe('acc_checking');

  await open(page, '/import', 'screen-import');
  await page.getByRole('radio', { name: 'File layouts' }).click();
  const row = page.getByTestId(`layout-${saved.signature}`);
  await expect(row).toContainText('e2e-bank.csv');
  await expect(page.getByTestId(`layout-meta-${saved.signature}`)).toContainText(
    'Into "Everyday Checking"',
  );
  expect(saved.mapping.skipRows).toBe(2);
  await expect(row).toContainText('last file had 2 lines above the header');
});
