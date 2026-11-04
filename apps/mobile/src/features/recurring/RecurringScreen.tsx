import { Screen } from '../../design/components/Screen';
import { Text } from '../../design/components/Text';
import { CurrencyChip } from '../currency/CurrencyChip';

export function RecurringScreen() {
  return (
    <Screen title="RecurringScreen" actions={<CurrencyChip />}>
      <Text>Coming soon</Text>
    </Screen>
  );
}
