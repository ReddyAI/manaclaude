import type { AiStatusResponse } from '@manaclaude/shared';
import { BackendError } from '../../../data/backend/client';
import { askFailure, questionProblem, statusLines } from '../ask';

const status = (patch: Partial<AiStatusResponse> = {}): AiStatusResponse => ({
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
  ...patch,
});

describe('questionProblem', () => {
  it('takes 3 to 500 characters after trimming', () => {
    expect(questionProblem('  hi ')).toMatch(/at least 3/);
    expect(questionProblem('why')).toBeNull();
    expect(questionProblem('x'.repeat(500))).toBeNull();
    expect(questionProblem('x'.repeat(501))).toMatch(/at most 500/);
  });
});

describe('statusLines', () => {
  it('says what Workers AI is set to and today’s use against the limit', () => {
    const s = statusLines(status());
    expect(s.headline).toBe('AI is on, using Workers AI');
    expect(s.lines[0]).toMatch(/^Today: 12 of 300 Workers AI calls used\. Every AI job/);
  });

  it('says when AI is off and nothing is sent', () => {
    expect(statusLines(status({ enabled: false })).headline).toBe('AI is off');
  });

  it('says when the chosen provider is not set up, and that the count is for Workers AI only', () => {
    const s = statusLines(status({ provider: 'anthropic' }));
    expect(s.headline).toBe('AI is on, using Anthropic');
    expect(s.lines).toEqual([
      'No Anthropic key is set on the Worker.',
      'Today: 12 of 300 Workers AI calls used. Your questions go to Anthropic, which this count does not cover.',
    ]);
  });

  it('says when today’s allowance is used up', () => {
    expect(statusLines(status({ workersAiCallsToday: 300 })).lines.at(-1)).toMatch(/used up/);
  });
});

describe('askFailure', () => {
  it('puts 409 ai_disabled and 503 ai_unavailable in plain words', () => {
    expect(
      askFailure(new BackendError(409, 'ai_disabled', 'AI is turned off in Settings.')),
    ).toEqual({
      kind: 'disabled',
      text: 'AI is switched off on your Worker, so nothing was sent to any AI. To ask questions, turn on AI features in Settings, AI.',
    });
    expect(
      askFailure(
        new BackendError(503, 'ai_unavailable', 'Workers AI is not bound to this Worker.'),
      ),
    ).toEqual({
      kind: 'unavailable',
      text: 'The AI could not be reached, so there is no answer. The Worker said: Workers AI is not bound to this Worker.',
    });
  });

  it('passes anything else on as the plain error', () => {
    expect(askFailure(new BackendError(0, 'offline', "The backend can't be reached."))).toEqual({
      kind: 'other',
      text: "No answer. The backend can't be reached.",
    });
    expect(askFailure(new BackendError(409, 'needs_repair', 'x')).kind).toBe('other');
  });
});
