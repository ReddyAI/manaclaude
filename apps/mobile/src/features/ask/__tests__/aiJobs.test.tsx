import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { DEFAULT_SETTINGS } from '@manaclaude/shared';
import { createSampleData } from '@manaclaude/shared/sample';
import { setBackendConfigForTests } from '../../../data/backend/config';
import { held, json, settle } from '../../../data/backend/__tests__/helpers';
import { resetBackendForTests } from '../../../data/backend/sync';
import { updateSettings } from '../../../data/settingsStore';
import { AiSection } from '../../settings/sections/AiSection';
import { goLive } from '../../transactions/__tests__/live';
import { AiJobsSheet } from '../AiJobsSheet';
import { AI_JOBS, aiJobText } from '../aiJobs';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), navigate: jest.fn(), replace: jest.fn(), back: jest.fn() },
}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));
jest.mock('expo-file-system', () => ({
  File: class {
    exists = false;
    create() {}
    write() {}
    delete() {}
    async text() {
      return '';
    }
  },
  Paths: { document: '/doc' },
}));
jest.mock('../../../design/haptics', () => ({
  ...jest.requireActual('../../../design/haptics'),
  haptic: jest.fn(),
}));

/** Block S: run the Worker's AI jobs now (POST /v1/ai/jobs/:job). Invented data. */

const press = (id: string) => fireEvent.press(screen.getByTestId(id));
const textOf = (id: string) => String(screen.getByTestId(id).props.children);
const ok = (job: string, changed: number, usedAi: boolean, note: string | null = null) =>
  json(200, { job, changed, usedAi, note });
const status = () =>
  json(200, {
    enabled: true,
    provider: 'workers_ai',
    configured: { workers_ai: true },
    workersAiCallsToday: 0,
    workersAiDailyLimit: 300,
  });

let backend: Awaited<ReturnType<typeof goLive>> | undefined;
beforeEach(async () => {
  await act(() => updateSettings({ ...DEFAULT_SETTINGS }));
});
afterEach(() => {
  backend?.restore();
  backend = undefined;
  resetBackendForTests();
  setBackendConfigForTests({ url: '', token: '' });
});

describe('what a job did', () => {
  it('in plain words', () => {
    expect(aiJobText({ job: 'categorize', changed: 0, usedAi: false, note: null })).toBe(
      'Done. Nothing needed changing. It used rules and plain numbers only, no AI.',
    );
    expect(aiJobText({ job: 'categorize', changed: 1, usedAi: true, note: null })).toBe(
      'Done. 1 item changed or added. It used AI.',
    );
    expect(
      aiJobText({ job: 'recurring', changed: 4, usedAi: false, note: 'Daily AI limit reached.' }),
    ).toBe(
      'Done. 4 items changed or added. It used rules and plain numbers only, no AI. Daily AI limit reached.',
    );
  });

  it('every job the Worker takes, and nothing else', () => {
    expect(AI_JOBS.map((j) => j.job)).toEqual([
      'merchants',
      'categorize',
      'recurring',
      'alerts',
      'recap_week',
      'recap_month',
    ]);
  });
});

describe('Run AI jobs now', () => {
  it('runs the one tapped, loads the data again and says what it did', async () => {
    backend = await goLive(createSampleData(), {
      'POST /v1/ai/jobs/categorize': () => ok('categorize', 3, true),
      'GET /v1/ai/status': status,
    });
    await render(<AiJobsSheet visible onClose={() => {}} />);
    const loadsBefore = backend.sent('GET /v1/dataset').length;
    await press('ai-job-run-categorize');
    await waitFor(() => expect(screen.getByTestId('ai-job-result-categorize')).toBeTruthy());
    expect(textOf('ai-job-result-categorize')).toBe('Done. 3 items changed or added. It used AI.');
    expect(backend.sent('POST /v1/ai/jobs/categorize')).toHaveLength(1);
    expect(backend.calls.filter((c) => c.path.startsWith('/v1/ai/jobs/'))).toHaveLength(1);
    expect(backend.sent('GET /v1/dataset').length).toBe(loadsBefore + 1);
  });

  it('reloads the alerts after the alerts job', async () => {
    backend = await goLive(createSampleData(), {
      'POST /v1/ai/jobs/alerts': () => ok('alerts', 1, false),
      'GET /v1/alerts': () => json(200, { alerts: [] }),
      'GET /v1/ai/status': status,
    });
    await render(<AiJobsSheet visible onClose={() => {}} />);
    await press('ai-job-run-alerts');
    await waitFor(() => expect(backend!.sent('GET /v1/alerts')).toHaveLength(1));
  });

  it('says what went wrong', async () => {
    backend = await goLive(createSampleData(), {
      'POST /v1/ai/jobs/recap_month': () =>
        json(500, { error: 'internal', message: 'The recap could not be written.' }),
    });
    await render(<AiJobsSheet visible onClose={() => {}} />);
    await press('ai-job-run-recap_month');
    await waitFor(() =>
      expect(textOf('ai-job-result-recap_month')).toBe('The recap could not be written.'),
    );
  });

  it('one job at a time, and one run for a fast double tap', async () => {
    const slow = held();
    backend = await goLive(createSampleData(), {
      'POST /v1/ai/jobs/merchants': () => slow.promise,
      'POST /v1/ai/jobs/recurring': () => ok('recurring', 0, false),
      'GET /v1/ai/status': status,
    });
    await render(<AiJobsSheet visible onClose={() => {}} />);
    await act(async () => {
      fireEvent.press(screen.getByTestId('ai-job-run-merchants'));
      fireEvent.press(screen.getByTestId('ai-job-run-merchants'));
      fireEvent.press(screen.getByTestId('ai-job-run-recurring'));
      await settle();
    });
    expect(backend.sent('POST /v1/ai/jobs/merchants')).toHaveLength(1);
    expect(backend.sent('POST /v1/ai/jobs/recurring')).toHaveLength(0);
    expect(screen.getByTestId('ai-job-run-recurring')).toBeDisabled();
    await act(async () => {
      slow.release(200, { job: 'merchants', changed: 2, usedAi: true, note: null });
      await settle();
    });
    expect(textOf('ai-job-result-merchants')).toBe('Done. 2 items changed or added. It used AI.');
  });

  it('with AI off it says nothing goes to any AI', async () => {
    backend = await goLive(createSampleData());
    await act(() => updateSettings({ aiEnabled: false }));
    await render(<AiJobsSheet visible onClose={() => {}} />);
    expect(
      screen.getByText(/AI is off, so these run with rules and plain numbers only/),
    ).toBeTruthy();
  });

  it('needs the Worker; Settings offers it only with one', async () => {
    resetBackendForTests();
    await render(<AiJobsSheet visible onClose={() => {}} />);
    expect(screen.getByTestId('ai-jobs-no-backend')).toBeTruthy();
    const section = await render(<AiSection />);
    expect(screen.queryByTestId('settings-ai-jobs')).toBeNull();
    await section.unmount();
    backend = await goLive(createSampleData());
    await render(<AiSection />);
    await press('settings-ai-jobs');
    expect(screen.getAllByTestId('ai-jobs-sheet').length).toBeGreaterThan(0);
  });
});
