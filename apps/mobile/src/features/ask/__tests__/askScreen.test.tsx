import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { AiStatusResponse } from '@manaclaude/shared';
import { setBackendConfigForTests } from '../../../data/backend/config';
import { fakeBackend, held, json, settle } from '../../../data/backend/__tests__/helpers';
import { aiStatusStore } from '../aiStatus';
import { AskEntry } from '../AskEntry';
import { AskScreen } from '../AskScreen';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), navigate: jest.fn(), replace: jest.fn(), back: jest.fn() },
}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));

const STATUS: AiStatusResponse = {
  enabled: true,
  provider: 'workers_ai',
  configured: {
    workers_ai: true,
    anthropic: false,
    openai: false,
    openai_compatible: false,
    gemini_paid: false,
  },
  workersAiCallsToday: 12,
  workersAiDailyLimit: 300,
};
const QUESTION = 'How much did I spend on coffee in October?';
const ANSWER = 'You spent 84.20 USD on Coffee in October 2026.';
const STATUS_KEY = 'GET /v1/ai/status';
const ASK = 'POST /v1/ai/ask';

let backend: ReturnType<typeof fakeBackend>;
let calls = 12;
function worker(ask: Parameters<typeof fakeBackend>[0][string], status = STATUS) {
  calls = status.workersAiCallsToday;
  backend = fakeBackend({
    [STATUS_KEY]: () => json(200, { ...status, workersAiCallsToday: calls }),
    [ASK]: (call) => {
      calls += 1;
      return ask(call);
    },
  });
}
const answering = () => worker(() => json(200, { answer: ANSWER }));

async function type(text: string) {
  await fireEvent.changeText(screen.getByTestId('ask-question'), text);
}
const press = (id: string) => fireEvent.press(screen.getByTestId(id));

beforeEach(() => {
  jest.clearAllMocks();
  aiStatusStore.reset();
  setBackendConfigForTests({ url: 'https://api.demo.test', token: 'demo-token' });
});
afterEach(() => backend?.restore());

describe('Ask AI', () => {
  it('asks for the backend first and sends nothing without one', async () => {
    answering();
    setBackendConfigForTests({ url: '', token: '' });
    await render(<AskScreen />);
    expect(screen.getByText('Set up the backend first')).toBeTruthy();
    expect(backend.calls).toHaveLength(0);
  });

  it('shows what the AI is set to and today’s use', async () => {
    answering();
    await render(<AskScreen />);
    await waitFor(() => expect(screen.getByTestId('ask-status')).toBeTruthy());
    expect(screen.getByText('AI is on, using Workers AI')).toBeTruthy();
    expect(screen.getByText(/^Today: 12 of 300 Workers AI calls used\./)).toBeTruthy();
  });

  it('sends the trimmed question, shows the answer and the new count', async () => {
    answering();
    await render(<AskScreen />);
    await waitFor(() => expect(screen.getByTestId('ask-status')).toBeTruthy());
    await type(`  ${QUESTION} `);
    await press('ask-send');
    await waitFor(() => expect(screen.getByText(ANSWER)).toBeTruthy());
    expect(backend.sent(ASK)).toHaveLength(1);
    expect(backend.sent(ASK)[0]!.body).toEqual({ question: QUESTION });
    expect(screen.getByText(QUESTION)).toBeTruthy();
    expect(screen.getByTestId('ask-question').props.value).toBe('');
    await waitFor(() => expect(screen.getByText(/^Today: 13 of 300/)).toBeTruthy());
  });

  it('sends one question for a fast double tap', async () => {
    const slow = held();
    worker(() => slow.promise);
    await render(<AskScreen />);
    await type(QUESTION);
    await act(async () => {
      fireEvent.press(screen.getByTestId('ask-send'));
      fireEvent.press(screen.getByTestId('ask-send'));
    });
    expect(backend.sent(ASK)).toHaveLength(1);
    await act(async () => {
      slow.release(200, { answer: ANSWER });
      await settle();
    });
    expect(screen.getAllByText(ANSWER)).toHaveLength(1);
  });

  it('fills the field from an example', async () => {
    answering();
    await render(<AskScreen />);
    await press('ask-example-0');
    expect(screen.getByTestId('ask-question').props.value).toBe(
      'How much did I spend on restaurants last month?',
    );
  });

  it('sends nothing for a question that is too short', async () => {
    answering();
    await render(<AskScreen />);
    await type('hi');
    await press('ask-send');
    expect(screen.getByText('Type a question of at least 3 characters.')).toBeTruthy();
    expect(backend.sent(ASK)).toHaveLength(0);
  });

  it('says plainly when AI is switched off (409 ai_disabled)', async () => {
    worker(() => json(409, { error: 'ai_disabled', message: 'AI is turned off in Settings.' }));
    await render(<AskScreen />);
    await waitFor(() => expect(screen.getByTestId('ask-status')).toBeTruthy());
    await type(QUESTION);
    await press('ask-send');
    await waitFor(() => expect(screen.getByTestId('ask-failure-disabled')).toBeTruthy());
    expect(screen.getByTestId('ask-failure-disabled').props.children).toBe(
      'AI is switched off on your Worker, so nothing was sent to any AI. To ask questions, turn on AI features in Settings, AI.',
    );
    expect(screen.queryByText(ANSWER)).toBeNull();
    // The question stays in the field so it can be sent once AI is on.
    expect(screen.getByTestId('ask-question').props.value).toBe(QUESTION);
    expect(backend.sent(STATUS_KEY).length).toBeGreaterThanOrEqual(2);
  });

  it('says plainly when the AI cannot be reached (503 ai_unavailable)', async () => {
    worker(() =>
      json(503, {
        error: 'ai_unavailable',
        message: 'Workers AI could not answer (Binding AI needs to be run remotely).',
      }),
    );
    await render(<AskScreen />);
    await type(QUESTION);
    await press('ask-send');
    await waitFor(() => expect(screen.getByTestId('ask-failure-unavailable')).toBeTruthy());
    expect(screen.getByTestId('ask-failure-unavailable').props.children).toBe(
      'The AI could not be reached, so there is no answer. The Worker said: Workers AI could not answer (Binding AI needs to be run remotely).',
    );
  });

  it('offers no Ask while the status says AI is off', async () => {
    answering();
    backend.restore();
    worker(() => json(200, { answer: ANSWER }), { ...STATUS, enabled: false });
    await render(<AskScreen />);
    await waitFor(() => expect(screen.getByText('AI is off')).toBeTruthy());
    expect(screen.getByTestId('ask-send').props.accessibilityState.disabled).toBe(true);
    expect(screen.getByTestId('ask-open-settings')).toBeTruthy();
    await type(QUESTION);
    await press('ask-send');
    expect(backend.sent(ASK)).toHaveLength(0);
  });

  it('keeps nothing on the device: no storage write, gone after the screen closes', async () => {
    answering();
    const view = await render(<AskScreen />);
    await type(QUESTION);
    await press('ask-send');
    await waitFor(() => expect(screen.getByText(ANSWER)).toBeTruthy());
    const writes = (AsyncStorage.setItem as jest.Mock).mock.calls.map((c) => String(c[1]));
    expect(writes.some((w) => w.includes('coffee') || w.includes('84.20'))).toBe(false);
    await view.unmount();
    await render(<AskScreen />);
    await waitFor(() => expect(screen.getByTestId('ask-status')).toBeTruthy());
    expect(screen.queryByText(ANSWER)).toBeNull();
    expect(screen.queryByText(QUESTION)).toBeNull();
  });

  it('drops an answer that arrives after the screen closed', async () => {
    const slow = held();
    worker(() => slow.promise);
    const view = await render(<AskScreen />);
    await type(QUESTION);
    await press('ask-send');
    await view.unmount();
    await act(async () => {
      slow.release(200, { answer: ANSWER });
      await settle();
    });
    await render(<AskScreen />);
    expect(screen.queryByText(ANSWER)).toBeNull();
  });

  it('clears the answers when the backend changes and ignores one asked of the old backend', async () => {
    const slow = held();
    let n = 0;
    worker(() => {
      n += 1;
      return n === 1 ? json(200, { answer: ANSWER }) : slow.promise;
    });
    await render(<AskScreen />);
    await type(QUESTION);
    await press('ask-send');
    await waitFor(() => expect(screen.getByText(ANSWER)).toBeTruthy());
    await type('And in September?');
    await press('ask-send');
    await act(async () => {
      setBackendConfigForTests({ url: 'https://other.demo.test', token: 'other-token' });
      await settle();
    });
    expect(screen.queryByText(ANSWER)).toBeNull();
    await act(async () => {
      slow.release(200, { answer: 'September answer from the old backend.' });
      await settle();
    });
    expect(screen.queryByText('September answer from the old backend.')).toBeNull();
    expect(screen.queryByTestId('ask-answers')).toBeNull();
    expect(screen.queryByTestId('ask-failure-other')).toBeNull();
    expect(screen.queryByTestId('ask-waiting')).toBeNull();
  });

  it('clears the answers on request', async () => {
    answering();
    await render(<AskScreen />);
    await type(QUESTION);
    await press('ask-send');
    await waitFor(() => expect(screen.getByText(ANSWER)).toBeTruthy());
    await press('ask-clear');
    expect(screen.queryByText(ANSWER)).toBeNull();
  });
});

describe('Ask AI on Home', () => {
  it('shows the row only with a backend set', async () => {
    answering();
    const view = await render(<AskEntry />);
    expect(screen.getByTestId('ask-entry')).toBeTruthy();
    await view.unmount();
    setBackendConfigForTests({ url: '', token: '' });
    await render(<AskEntry />);
    expect(screen.queryByTestId('ask-entry')).toBeNull();
  });
});
