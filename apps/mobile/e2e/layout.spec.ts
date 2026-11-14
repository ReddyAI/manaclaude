import { auditPage } from './harness/audit';
import { expect, open, test } from './fixtures';

/**
 * Block U, kept from breaking again: on the screens that showed the problems
 * (faint text, income and badge colours, the tab bar, initials, accent
 * buttons, the look cards), every look and scheme has no text below WCAG AA
 * contrast, nothing cut off or overlapping, no sideways scrolling, and no
 * control without a name. The full sweep of every screen and sheet is
 * audit.spec.ts, run on demand.
 */

const LOOKS = ['midnight', 'warm', 'compact'] as const;
const SCHEMES = ['light', 'dark'] as const;
const SCREENS: [route: string, testId: string][] = [
  ['/', 'screen-dashboard'],
  ['/accounts', 'screen-accounts'],
  ['/budgets', 'screen-budgets'],
  ['/networth/investments', 'screen-investments'],
  ['/settings', 'screen-settings'],
];

test.describe.configure({ mode: 'serial' });

test.afterAll(async ({ request, backend }) => {
  // Put the Worker's look back for the specs that run after this one.
  await request.patch(`${backend.url}/v1/settings`, {
    headers: { authorization: `Bearer ${backend.token}`, 'content-type': 'application/json' },
    data: JSON.stringify({ look: 'midnight', colorScheme: 'system' }),
  });
});

for (const look of LOOKS) {
  for (const scheme of SCHEMES) {
    test(`${look} ${scheme}: readable, nothing cut off`, async ({ page, api }) => {
      await api.send('PATCH', '/v1/settings', { look, colorScheme: scheme });
      await page.emulateMedia({ colorScheme: scheme });
      for (const [route, testId] of SCREENS) {
        await open(page, route, testId);
        await page.waitForTimeout(300);
        const findings = await auditPage(page);
        expect(findings, `${route} in ${look} ${scheme}`).toEqual([]);
      }
      // The look cards show their whole description (they were cut to two lines).
      for (const card of LOOKS) {
        const clamp = await page
          .getByTestId(`look-${card}-description`)
          .evaluate((el) => getComputedStyle(el).webkitLineClamp);
        expect(clamp).toBe('none');
      }
    });
  }
}
