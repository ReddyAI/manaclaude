import { Screen } from '../../design/components/Screen';
import { Text } from '../../design/components/Text';
import { CurrencyChip } from '../currency/CurrencyChip';

export function TransactionsScreen() {
  return (
    <Screen title="TransactionsScreen" actions={<CurrencyChip />}>
      <Text>Coming soon</Text>
    </Screen>
  );
}
