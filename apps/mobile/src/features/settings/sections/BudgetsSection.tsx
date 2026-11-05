import { Button } from '../../../design/components/Button';
import { Switch } from '../../../design/components/Controls';
import { updateSettings, useSettings } from '../../../data/settingsStore';
import { goTo } from '../../planning/navigate';
import { SettingsGroup, SettingsRow } from '../SettingsRow';

/**
 * Budget and planning settings (session C): Flex mode, rollover default and
 * a way into the retirement assumptions.
 */
export function BudgetsSection() {
  const settings = useSettings();
  return (
    <SettingsGroup title="Budgets and planning">
      <SettingsRow
        label="Flex budgeting"
        description="Group budgets as fixed, flexible and non-monthly"
        control={
          <Switch
            value={settings.flexBudgeting ?? false}
            onValueChange={(flexBudgeting) => updateSettings({ flexBudgeting })}
            accessibilityLabel="Flex budgeting"
            testID="setting-flex"
          />
        }
      />
      <SettingsRow
        label="Roll over by default"
        description="New budget lines carry what is left into next month"
        control={
          <Switch
            value={settings.defaultRollover ?? false}
            onValueChange={(defaultRollover) => updateSettings({ defaultRollover })}
            accessibilityLabel="Roll over by default"
            testID="setting-rollover"
          />
        }
      />
      <SettingsRow
        label="Retirement assumptions"
        description="Return, inflation, savings and target"
        control={
          <Button
            label="Open"
            variant="secondary"
            size="sm"
            onPress={() => goTo('/planning')}
            testID="setting-open-planning"
          />
        }
      />
    </SettingsGroup>
  );
}
