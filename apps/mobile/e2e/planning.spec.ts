import { expect, open, test } from './fixtures';

/**
 * Block W: the range of outcomes on Planning. The same inputs give the same
 * answer after a reload, it says it is an estimate, and with the CPU slowed
 * to roughly a phone's speed a changed setting updates it quickly.
 */

test('range of outcomes: repeatable, an estimate, and quick to update', async ({
  page,
  api,
}, info) => {
  // Planning starts from the investment accounts the Worker has.
  const data = await api.dataset();
  expect(data.accounts.some((a) => a.type === 'brokerage' || a.type === 'retirement')).toBe(true);

  await open(page, '/planning', 'screen-planning');
  const chance = page.getByTestId('mc-chance');
  await expect(chance).toHaveText(/^(\d+%|less than 1%|more than 99%)$/);
  const first = await chance.textContent();
  const p50 = await page.getByTestId('mc-p50').textContent();
  await expect(page.getByTestId('mc-note')).toContainText('An estimate, not a promise.');
  await expect(page.getByTestId('mc-chart')).toBeVisible();

  await open(page, '/planning', 'screen-planning');
  await expect(chance).toHaveText(first!);
  await expect(page.getByTestId('mc-p50')).toHaveText(p50!);

  // About a mid-range phone: Chromium's CPU slowed four times.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const field = page.getByTestId('plan-field-volatility');
  await field.fill('35');
  const start = Date.now();
  await field.blur();
  await expect(page.getByTestId('mc-note')).toContainText('35% swings');
  const ms = Date.now() - start;
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  info.annotations.push({ type: 'update time at 4x CPU slowdown', description: `${ms} ms` });
  console.warn(`[${info.project.name}] range of outcomes updated in ${ms} ms at 4x CPU slowdown`);
  expect(ms).toBeLessThan(2_000);
});
