import { Screen } from '../../design/components/Screen';
import { Text } from '../../design/components/Text';
import { CurrencyChip } from '../currency/CurrencyChip';

export function NetWorthScreen() {
  return (
    <Screen title="NetWorthScreen" actions={<CurrencyChip />}>
      <Text>Coming soon</Text>
    </Screen>
  );
}
