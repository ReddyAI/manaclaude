import type { MoneyPolicies } from '@manaclaude/shared';
import { Switch } from '../../../design/components/Controls';
import { updateSettings, useSettings } from '../../../data/settingsStore';
import { SettingsGroup, SettingsRow } from '../SettingsRow';

type ToggleKey = 'transfers' | 'cardPayments' | 'investmentContributions' | 'loanPrincipal';

const TOGGLES: { key: ToggleKey; label: string; description: string }[] = [
  {
    key: 'transfers',
    label: 'Count transfers as spending',
    description: 'Moves between your own accounts',
  },
  {
    key: 'cardPayments',
    label: 'Count card payments as spending',
    description: 'The card purchases already count',
  },
  {
    key: 'investmentContributions',
    label: 'Count investing as spending',
    description: 'Money into brokerage and retirement accounts',
  },
  {
    key: 'loanPrincipal',
    label: 'Count loan principal as spending',
    description: 'Interest always counts',
  },
];

/** How money counts in reports (session B owns this section). Defaults come from the brief. */
export function MoneyPoliciesSection() {
  const settings = useSettings();
  const policies = settings.moneyPolicies;
  const set = (patch: Partial<MoneyPolicies>) =>
    updateSettings({ moneyPolicies: { ...policies, ...patch } });
  return (
    <SettingsGroup title="How money counts">
      {TOGGLES.map((t) => (
        <SettingsRow
          key={t.key}
          label={t.label}
          description={t.description}
          control={
            <Switch
              value={policies[t.key] === 'count'}
              onValueChange={(v) => set({ [t.key]: v ? 'count' : 'exclude' })}
              accessibilityLabel={t.label}
            />
          }
        />
      ))}
      <SettingsRow
        label="Refunds reduce their category"
        description="Off: refunds count as income instead"
        control={
          <Switch
            value={policies.refunds === 'reduce_category'}
            onValueChange={(v) => set({ refunds: v ? 'reduce_category' : 'count_as_income' })}
            accessibilityLabel="Refunds reduce their category"
          />
        }
      />
      <SettingsRow
        label="Allow a category to go below zero"
        description="A refund bigger than this month's spending shows as a credit"
        control={
          <Switch
            value={policies.categoryFloor === 'none'}
            onValueChange={(v) => set({ categoryFloor: v ? 'none' : 'zero' })}
            accessibilityLabel="Allow a category to go below zero"
          />
        }
      />
      <SettingsRow
        label="Include pending transactions"
        control={
          <Switch
            value={policies.pendingTransactions === 'include'}
            onValueChange={(v) => set({ pendingTransactions: v ? 'include' : 'exclude' })}
            accessibilityLabel="Include pending transactions"
          />
        }
      />
    </SettingsGroup>
  );
}
