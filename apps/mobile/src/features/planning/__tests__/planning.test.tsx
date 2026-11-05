import { act, fireEvent, screen } from '@testing-library/react-native';
import { renderScreen } from './helpers';
import { DEFAULT_SETTINGS } from '@manaclaude/shared';
import { createSampleData } from '@manaclaude/shared/sample';
import { getSettings, updateSettings } from '../../../data/settingsStore';
import { setFinance } from '../../../data/store';
import { PlanningScreen } from '../PlanningScreen';

describe('Planning', () => {
  beforeEach(async () => {
    await act(() => {
      setFinance(createSampleData());
      updateSettings({ ...DEFAULT_SETTINGS, planning: undefined });
    });
  });

  it('shows the target, the chart and a status line', async () => {
    await renderScreen(<PlanningScreen />);
    expect(screen.getByTestId('fire-target')).toBeTruthy();
    expect(screen.getByTestId('fire-chart')).toBeTruthy();
    expect(screen.getByTestId('fire-status').props.children).toMatch(/track|out of reach/i);
  });

  it('saves a changed assumption and updates the projection', async () => {
    await renderScreen(<PlanningScreen />);
    const before = screen.getByTestId('fire-status').props.children;
    const input = screen.getByTestId('plan-field-monthlyContribution');
    await fireEvent.changeText(input, '9000');
    await fireEvent.press(input);
    await fireEvent(input, 'endEditing');
    expect(getSettings().planning?.monthlyContribution).toBe(900_000);
    expect(screen.getByTestId('fire-status').props.children).not.toBe(before);
  });

  it('ignores a bad value', async () => {
    await renderScreen(<PlanningScreen />);
    const input = screen.getByTestId('plan-field-annualReturn');
    await fireEvent.changeText(input, 'lots');
    await fireEvent(input, 'endEditing');
    expect(getSettings().planning).toBeUndefined();
  });

  it('shows progress for each goal', async () => {
    await renderScreen(<PlanningScreen />);
    for (const id of ['goal_emergency', 'goal_india_home', 'goal_fire', 'goal_auto_loan']) {
      expect(screen.getByTestId(id.replace('goal_', 'goal-goal_'))).toBeTruthy();
    }
  });
});
