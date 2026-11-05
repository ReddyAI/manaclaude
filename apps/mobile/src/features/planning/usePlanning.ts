import { DEFAULT_PLANNING, type PlanningAssumptions } from '@manaclaude/shared';
import { updateSettings, useSettings } from '../../data/settingsStore';

/** Retirement / FIRE assumptions, saved with the other settings. */
export function usePlanning(): PlanningAssumptions {
  const { planning } = useSettings();
  return { ...DEFAULT_PLANNING, ...(planning ?? {}) };
}

export function updatePlanning(current: PlanningAssumptions, patch: Partial<PlanningAssumptions>) {
  updateSettings({ planning: { ...current, ...patch } });
}
