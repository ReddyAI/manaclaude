import { SegmentedControl } from '../../../design/components/Controls';
import { updateSettings, useSettings } from '../../../data/settingsStore';
import { SettingsGroup, SettingsRow } from '../SettingsRow';

/** Display currency and dashboard layout (session A owns this section). */
export function DisplaySection() {
  const settings = useSettings();
  return (
    <SettingsGroup title="Display">
      <SettingsRow
        label="Display currency"
        description="Same as tapping the currency chip in any header"
        below
        control={
          <SegmentedControl
            accessibilityLabel="Display currency"
            value={settings.displayCurrencyMode}
            onChange={(displayCurrencyMode) => updateSettings({ displayCurrencyMode })}
            options={[
              { value: 'USD', label: 'USD' },
              { value: 'INR', label: 'INR' },
              { value: 'BOTH', label: 'Both' },
              { value: 'NATIVE', label: 'Native' },
            ]}
          />
        }
      />
      <SettingsRow
        label="Dashboard"
        below
        control={
          <SegmentedControl
            accessibilityLabel="Dashboard layout"
            value={settings.dashboardLayout}
            onChange={(dashboardLayout) => updateSettings({ dashboardLayout })}
            options={[
              { value: 'widgets', label: 'Widgets' },
              { value: 'safe_to_spend', label: 'Safe to spend' },
            ]}
          />
        }
      />
    </SettingsGroup>
  );
}
