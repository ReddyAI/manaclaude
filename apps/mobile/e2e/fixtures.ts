import { test as base, expect, type Page } from '@playwright/test';
import type { FinanceDataset } from '@manaclaude/shared';

export interface E2eOptions {
  /** Port of the local Worker this project (screen width) uses. */
  backendPort: number;
}

export interface Backend {
  url: string;
  token: string;
}

export interface WorkerApi {
  get<T>(route: string): Promise<T>;
  send<T>(method: 'POST' | 'PUT' | 'PATCH' | 'DELETE', route: string, body?: unknown): Promise<T>;
  dataset(): Promise<FinanceDataset>;
}

interface Fixtures {
  backend: Backend;
  api: WorkerApi;
  /** Page errors, console errors and failed requests seen during the test. Checked after it. */
  errors: string[];
}

/**
 * The browser's own line for a failed request. Failed requests are reported
 * separately with their method and path (below), so this line is skipped.
 */
const EXPECTED_CONSOLE = [/^Failed to load resource: the server responded with a status of/];

/**
 * Failed requests the app makes on purpose. The import flow asks once per
 * backend whether the Worker has the manual-account route by sending an empty
 * body, which can never create anything: 400 means the route is there
 * (features/import/importApi.ts, manualAccountsSupported).
 */
const EXPECTED_FAILURES = ['POST /v1/accounts/manual answered 400'];

export const test = base.extend<Fixtures & E2eOptions>({
  backendPort: [8791, { option: true }],

  backend: async ({ backendPort }, provide) => {
    const token = process.env.E2E_TOKEN;
    if (!token) throw new Error('E2E_TOKEN is not set; run through playwright.config.ts');
    await provide({ url: `http://127.0.0.1:${backendPort}`, token });
  },

  api: async ({ backend, request }, provide) => {
    const headers = { authorization: `Bearer ${backend.token}` };
    const read = async <T>(res: Awaited<ReturnType<typeof request.get>>, what: string) => {
      if (!res.ok()) throw new Error(`${what} answered ${res.status()}: ${await res.text()}`);
      return (await res.json()) as T;
    };
    const api: WorkerApi = {
      get: async (route) => read(await request.get(`${backend.url}${route}`, { headers }), route),
      send: async (method, route, body) =>
        read(
          await request.fetch(`${backend.url}${route}`, {
            method,
            headers: { ...headers, 'content-type': 'application/json' },
            data: body === undefined ? undefined : JSON.stringify(body),
          }),
          `${method} ${route}`,
        ),
      dataset: () => api.get<FinanceDataset>('/v1/dataset'),
    };
    await provide(api);
  },

  // eslint-disable-next-line no-empty-pattern -- Playwright fixtures take an object pattern.
  errors: async ({}, provide) => {
    await provide([]);
  },

  page: async ({ page, backend, errors }, provide) => {
    await page.addInitScript(
      ({ url, token }) => {
        // Only the first load of a test sets these, so a test can change them.
        if (sessionStorage.getItem('e2e.ready')) return;
        sessionStorage.setItem('e2e.ready', '1');
        localStorage.setItem('billionaire.backendUrl', url);
        localStorage.setItem('billionaire.apiToken', token);
      },
      { url: backend.url, token: backend.token },
    );
    page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
    page.on('response', (r) => {
      if (r.status() < 400) return;
      const { pathname } = new URL(r.url());
      const line = `${r.request().method()} ${pathname} answered ${r.status()}`;
      if (!EXPECTED_FAILURES.includes(line)) errors.push(line);
    });
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const text = m.text();
      if (EXPECTED_CONSOLE.some((re) => re.test(text))) return;
      errors.push(`console: ${text}`);
    });
    await provide(page);
    expect(errors, 'no page errors, console errors or failed requests').toEqual([]);
  },
});

export { expect };

/**
 * Opens a route and waits until its screen is shown with the Worker's data
 * (the app shows invented sample data until GET /v1/dataset answers).
 */
export async function open(page: Page, route: string, screenTestId: string): Promise<void> {
  const loaded = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/v1/dataset' && r.request().method() === 'GET',
  );
  await page.goto(route);
  const res = await loaded;
  expect(res.status(), 'GET /v1/dataset').toBe(200);
  await expect(page.getByTestId(screenTestId).first()).toBeVisible();
  // Let the store take the answer before the test reads the screen.
  await page.waitForTimeout(300);
}

export const isPhone = (page: Page) => (page.viewportSize()?.width ?? 0) < 600;
