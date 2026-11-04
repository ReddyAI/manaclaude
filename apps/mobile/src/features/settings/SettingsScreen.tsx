import { Screen } from '../../design/components/Screen';
import { Text } from '../../design/components/Text';
import { CurrencyChip } from '../currency/CurrencyChip';

export function SettingsScreen() {
  return (
    <Screen title="SettingsScreen" actions={<CurrencyChip />}>
      <Text>Coming soon</Text>
    </Screen>
  );
}
