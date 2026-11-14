import { DEFAULT_PLANNING, type PlanningAssumptions } from '@manaclaude/shared';
import { updateSettings, useSettings } from '../../data/settingsStore';
import { DEFAULT_VOLATILITY } from './monteCarlo';

/**
 * Retirement / FIRE assumptions, saved with the other settings on this
 * device. `volatility` is kept next to them in the same saved object; the
 * shared PlanningAssumptions type does not have it, and planning is not sent
 * to the Worker.
 */
export type Planning = PlanningAssumptions & {
  /** Yearly standard deviation of returns for the range of outcomes (0.15 = 15%). */
  volatility: number;
};

export function usePlanning(): Planning {
  const { planning } = useSettings();
  return { ...DEFAULT_PLANNING, volatility: DEFAULT_VOLATILITY, ...(planning ?? {}) };
}

export function updatePlanning(current: Planning, patch: Partial<Planning>) {
  const next: Planning = { ...current, ...patch };
  updateSettings({ planning: next });
}
