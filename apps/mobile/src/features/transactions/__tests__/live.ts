import type { FinanceDataset } from '@manaclaude/shared';
import { setBackendConfigForTests } from '../../../data/backend/config';
import { fakeBackend, json } from '../../../data/backend/__tests__/helpers';
import { refreshDataset, resetBackendForTests } from '../../../data/backend/sync';

/**
 * Loads `data` from a stand-in Worker, so the app treats it as the selected
 * backend's data and sends changes to it. All data is invented.
 */
export async function goLive(
  data: FinanceDataset,
  handlers: Parameters<typeof fakeBackend>[0] = {},
): Promise<ReturnType<typeof fakeBackend>> {
  resetBackendForTests();
  const backend = fakeBackend({ 'GET /v1/dataset': () => json(200, data), ...handlers });
  setBackendConfigForTests({ url: 'https://api.demo.test', token: 'demo-token' });
  if (!(await refreshDataset())) throw new Error('the stand-in dataset did not load');
  return backend;
}
