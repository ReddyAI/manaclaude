import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { Rule } from '@manaclaude/shared';
import { createSampleData } from '@manaclaude/shared/sample';
import { router } from 'expo-router';
import { setBackendConfigForTests } from '../../../data/backend/config';
import { fakeBackend, json } from '../../../data/backend/__tests__/helpers';
import { canSaveToBackend, scheduleRefresh } from '../../../data/backend/sync';
import { getFinance, setFinance } from '../../../data/store';
import { getRulesNoticeForTests, rulesStore } from '../actions';
import { RuleEditScreen } from '../RuleEditScreen';
import { RulesScreen } from '../RulesScreen';

let mockParams: { id?: string } = {};
jest.mock('expo-router', () => ({
  router: {
    push: jest.fn(),
    navigate: jest.fn(),
    replace: jest.fn(),
    back: jest.fn(),
    canGoBack: () => true,
  },
  useLocalSearchParams: () => mockParams,
}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));
jest.mock('../../../data/backend/sync', () => ({
  canSaveToBackend: jest.fn(() => true),
  scheduleRefresh: jest.fn(),
}));
const live = canSaveToBackend as jest.Mock;
const refresh = scheduleRefresh as jest.Mock;

const data = createSampleData();
/** Invented rules in the shape GET /v1/rules sends. */
const rule = (id: string, patch: Partial<Rule> = {}): Rule => ({
  id,
  name: `Rule ${id}`,
  enabled: true,
  priority: 100,
  match: 'all',
  conditions: [{ field: 'name', op: 'contains', value: 'corner cafe' }],
  actions: [{ type: 'set_category', categoryId: 'cat_paycheck' }],
  source: 'user',
  createdAt: '2026-11-01T00:00:00.000Z',
  updatedAt: '2026-11-01T00:00:00.000Z',
  ...patch,
});
const RULES = [
  rule('rule_cafe', { name: 'Cafe', priority: 10 }),
  rule('rule_off', { name: 'Old one', enabled: false, priority: 20 }),
  rule('rule_learned', { name: 'Learned one', source: 'learned', priority: 30 }),
];

const press = (id: string) => fireEvent.press(screen.getByTestId(id));
let backend: ReturnType<typeof fakeBackend>;

function worker(extra: Parameters<typeof fakeBackend>[0] = {}, rules = RULES) {
  backend = fakeBackend({
    'GET /v1/rules': () => json(200, { rules }),
    'POST /v1/rules': (call) =>
      json(201, {
        rule: { ...rule('rule_new'), ...(call.body as object), source: 'user' },
        applied: 4,
      }),
    ...Object.fromEntries(
      rules.map((r) => [
        `PUT /v1/rules/${r.id}`,
        (call: { body: unknown }) =>
          json(200, { rule: { ...r, ...(call.body as object) }, applied: 2 }),
      ]),
    ),
    ...Object.fromEntries(
      rules.map((r) => [`DELETE /v1/rules/${r.id}`, () => new Response(null, { status: 204 })]),
    ),
    'POST /v1/rules/run': () => json(200, { changed: 3 }),
    ...extra,
  });
  return backend;
}

beforeEach(() => {
  jest.clearAllMocks();
  live.mockReturnValue(true);
  rulesStore.reset();
  mockParams = {};
  setFinance({ ...data, rules: RULES });
  setBackendConfigForTests({ url: 'https://api.demo.test', token: 'demo-token' });
});
afterEach(() => backend?.restore());

describe('rules list', () => {
  it('lists the rules with their state and a plain summary', async () => {
    worker();
    await render(<RulesScreen />);
    await waitFor(() => expect(screen.getByTestId('rule-rule_cafe')).toBeTruthy());
    expect(screen.getByText('Off')).toBeTruthy();
    expect(screen.getByText('Learned')).toBeTruthy();
    expect(screen.getAllByText('If Name contains "corner cafe": category Paycheck')).toHaveLength(
      3,
    );
  });

  it('turns a rule off with a PUT of the whole rule and says how many changed', async () => {
    worker();
    await render(<RulesScreen />);
    await waitFor(() => expect(screen.getByTestId('rule-rule_cafe')).toBeTruthy());
    await press('rule-enabled-rule_cafe');
    await waitFor(() => expect(screen.getByTestId('rules-notice')).toBeTruthy());
    const sent = backend.sent('PUT /v1/rules/rule_cafe');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toEqual({
      name: 'Cafe',
      enabled: false,
      priority: 10,
      match: 'all',
      conditions: RULES[0]!.conditions,
      actions: RULES[0]!.actions,
    });
    expect(screen.getByTestId('rules-notice').props.children).toBe(
      'Turned off "Cafe". Rules changed 2 transactions. What it changed before stays as it is.',
    );
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(rulesStore.get().value!.find((r) => r.id === 'rule_cafe')!.enabled).toBe(false);
    expect(getFinance().rules.find((r) => r.id === 'rule_cafe')!.enabled).toBe(false);
  });

  it('leaves sample data alone when the data on screen is not this backend’s', async () => {
    worker();
    live.mockReturnValue(false);
    await render(<RulesScreen />);
    await waitFor(() => expect(screen.getByTestId('rule-rule_cafe')).toBeTruthy());
    await press('rule-enabled-rule_cafe');
    await waitFor(() => expect(screen.getByTestId('rules-notice')).toBeTruthy());
    expect(rulesStore.get().value!.find((r) => r.id === 'rule_cafe')!.enabled).toBe(false);
    expect(getFinance().rules.find((r) => r.id === 'rule_cafe')!.enabled).toBe(true);
  });

  it('applies the rules to stored transactions and reloads the data when some changed', async () => {
    worker();
    await render(<RulesScreen />);
    await waitFor(() => expect(screen.getByTestId('rule-rule_cafe')).toBeTruthy());
    await press('rules-run');
    await waitFor(() => expect(screen.getByTestId('rules-notice')).toBeTruthy());
    expect(backend.sent('POST /v1/rules/run')).toHaveLength(1);
    expect(screen.getByTestId('rules-notice').props.children).toBe('Rules changed 3 transactions.');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('does not reload the data when nothing changed', async () => {
    worker({ 'POST /v1/rules/run': () => json(200, { changed: 0 }) });
    await render(<RulesScreen />);
    await waitFor(() => expect(screen.getByTestId('rule-rule_cafe')).toBeTruthy());
    await press('rules-run');
    await waitFor(() => expect(screen.getByTestId('rules-notice')).toBeTruthy());
    expect(screen.getByTestId('rules-notice').props.children).toBe(
      'No transaction needed a change.',
    );
    expect(refresh).not.toHaveBeenCalled();
  });

  it('offers no run when every rule is off', async () => {
    worker({}, [rule('rule_off', { enabled: false })]);
    await render(<RulesScreen />);
    await waitFor(() => expect(screen.getByTestId('rule-rule_off')).toBeTruthy());
    expect(screen.getByTestId('rules-run').props.accessibilityState.disabled).toBe(true);
  });

  it('keeps the switch as it was when the Worker cannot be reached', async () => {
    worker({ 'PUT /v1/rules/rule_cafe': () => Promise.reject(new TypeError('offline')) });
    await render(<RulesScreen />);
    await waitFor(() => expect(screen.getByTestId('rule-rule_cafe')).toBeTruthy());
    await press('rule-enabled-rule_cafe');
    await waitFor(() => expect(screen.getByTestId('rules-problem')).toBeTruthy());
    expect(rulesStore.get().value!.find((r) => r.id === 'rule_cafe')!.enabled).toBe(true);
    expect(screen.getByTestId('rule-enabled-rule_cafe').props.accessibilityState.checked).toBe(
      true,
    );
  });
});

describe('rule form', () => {
  it('saves a new rule with exactly the body POST takes, then goes back to the list', async () => {
    worker();
    mockParams = { id: 'new' };
    await render(<RuleEditScreen />);
    await fireEvent.changeText(screen.getByTestId('rule-name'), 'Coffee shops');
    await fireEvent.changeText(screen.getByTestId('cond-0-text'), ' corner cafe ');
    await press('rule-add-condition');
    await press('cond-1-field-amount');
    await press('cond-1-op-between');
    await fireEvent.changeText(screen.getByTestId('cond-1-amount'), '2');
    await fireEvent.changeText(screen.getByTestId('cond-1-upto'), '15.50');
    await press('act-0-category');
    await press('category-cat_paycheck');
    await press('rule-add-action');
    await press('act-1-type-mark_reviewed');
    await press('rule-save');
    await waitFor(() => expect(router.back).toHaveBeenCalled());
    const sent = backend.sent('POST /v1/rules');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toEqual({
      name: 'Coffee shops',
      enabled: true,
      priority: 100,
      match: 'all',
      conditions: [
        { field: 'name', op: 'contains', value: 'corner cafe' },
        { field: 'amount', op: 'between', value: [2_00, 15_50] },
      ],
      actions: [{ type: 'set_category', categoryId: 'cat_paycheck' }, { type: 'mark_reviewed' }],
    });
    expect(getRulesNoticeForTests()).toBe('Saved "Coffee shops". Rules changed 4 transactions.');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('saves once for a fast double tap', async () => {
    worker();
    mockParams = { id: 'new' };
    await render(<RuleEditScreen />);
    await fireEvent.changeText(screen.getByTestId('rule-name'), 'Twice');
    await fireEvent.changeText(screen.getByTestId('cond-0-text'), 'x');
    await press('act-0-type-exclude');
    await act(async () => {
      fireEvent.press(screen.getByTestId('rule-save'));
      fireEvent.press(screen.getByTestId('rule-save'));
    });
    await waitFor(() => expect(router.back).toHaveBeenCalled());
    expect(backend.sent('POST /v1/rules')).toHaveLength(1);
  });

  it('sends nothing until the form is complete, and says what is missing', async () => {
    worker();
    mockParams = { id: 'new' };
    await render(<RuleEditScreen />);
    await press('rule-save');
    expect(screen.getByText('Give the rule a name.')).toBeTruthy();
    expect(screen.getByTestId('cond-0-problem').props.children).toBe('Type the text to look for.');
    expect(screen.getByTestId('act-0-problem').props.children).toBe('Pick a category.');
    expect(backend.calls).toHaveLength(0);
  });

  it('cannot save while the data on screen is not this backend’s', async () => {
    worker();
    live.mockReturnValue(false);
    mockParams = { id: 'new' };
    await render(<RuleEditScreen />);
    expect(screen.getByTestId('rule-not-loaded')).toBeTruthy();
    expect(screen.getByTestId('rule-save').props.accessibilityState.disabled).toBe(true);
  });

  it('offers no second action of a kind the rule already has', async () => {
    worker();
    mockParams = { id: 'new' };
    await render(<RuleEditScreen />);
    await press('rule-add-action');
    expect(screen.queryByTestId('act-1-type-set_category')).toBeNull();
    expect(screen.getByTestId('act-1-type-add_tag')).toBeTruthy();
  });

  it('opens a stored rule and saves it whole with PUT', async () => {
    worker();
    mockParams = { id: 'rule_cafe' };
    await render(<RuleEditScreen />);
    await waitFor(() => expect(screen.getByTestId('rule-name')).toBeTruthy());
    expect(screen.getByTestId('rule-name').props.value).toBe('Cafe');
    await fireEvent.changeText(screen.getByTestId('rule-priority'), '5');
    await press('rule-save');
    await waitFor(() => expect(router.back).toHaveBeenCalled());
    expect(backend.sent('PUT /v1/rules/rule_cafe')[0]!.body).toEqual({
      name: 'Cafe',
      enabled: true,
      priority: 5,
      match: 'all',
      conditions: RULES[0]!.conditions,
      actions: RULES[0]!.actions,
    });
    expect(rulesStore.get().value!.map((r) => r.id)).toEqual([
      'rule_cafe',
      'rule_off',
      'rule_learned',
    ]);
  });

  it('shows the Worker refusing a save and stays on the form', async () => {
    worker({
      'POST /v1/rules': () =>
        json(400, { error: 'invalid_body', message: 'conditions.0.value: Too long' }),
    });
    mockParams = { id: 'new' };
    await render(<RuleEditScreen />);
    await fireEvent.changeText(screen.getByTestId('rule-name'), 'X');
    await fireEvent.changeText(screen.getByTestId('cond-0-text'), 'x');
    await press('act-0-type-exclude');
    await press('rule-save');
    await waitFor(() => expect(screen.getByTestId('rule-problem')).toBeTruthy());
    expect(screen.getByText('conditions.0.value: Too long')).toBeTruthy();
    expect(router.back).not.toHaveBeenCalled();
  });

  it('deletes only after a second tap, and once for a fast double tap', async () => {
    worker();
    mockParams = { id: 'rule_off' };
    await render(<RuleEditScreen />);
    await waitFor(() => expect(screen.getByTestId('rule-delete')).toBeTruthy());
    await press('rule-delete');
    expect(backend.sent('DELETE /v1/rules/rule_off')).toHaveLength(0);
    await act(async () => {
      fireEvent.press(screen.getByTestId('rule-delete-confirm'));
      fireEvent.press(screen.getByTestId('rule-delete-confirm'));
    });
    await waitFor(() => expect(router.back).toHaveBeenCalled());
    expect(backend.sent('DELETE /v1/rules/rule_off')).toHaveLength(1);
    expect(rulesStore.get().value!.map((r) => r.id)).toEqual(['rule_cafe', 'rule_learned']);
    expect(getFinance().rules.map((r) => r.id)).toEqual(['rule_cafe', 'rule_learned']);
    expect(getRulesNoticeForTests()).toBe('Deleted "Old one". What it changed stays as it is.');
  });

  it('says so when the rule is not on the Worker', async () => {
    worker();
    mockParams = { id: 'rule_gone' };
    await render(<RuleEditScreen />);
    await waitFor(() => expect(screen.getByText('Rule not found')).toBeTruthy());
  });
});
