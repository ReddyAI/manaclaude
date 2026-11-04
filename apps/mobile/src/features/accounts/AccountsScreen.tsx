import { Screen } from '../../design/components/Screen';
import { Text } from '../../design/components/Text';
import { CurrencyChip } from '../currency/CurrencyChip';

export function AccountsScreen() {
  return (
    <Screen title="AccountsScreen" actions={<CurrencyChip />}>
      <Text>Coming soon</Text>
    </Screen>
  );
}
