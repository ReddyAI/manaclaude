import Constants from 'expo-constants';
import { Card } from '../../design/components/Card';
import { VStack } from '../../design/components/Layout';
import { Screen } from '../../design/components/Screen';
import { Text } from '../../design/components/Text';
import { AiSection } from './sections/AiSection';
import { AppearanceSection } from './sections/AppearanceSection';
import { BackendSection } from './sections/BackendSection';
import { BudgetsSection } from './sections/BudgetsSection';
import { DisplaySection } from './sections/DisplaySection';
import { ExchangeRatesSection } from './sections/ExchangeRatesSection';
import { MoneyPoliciesSection } from './sections/MoneyPoliciesSection';
import { OrganizeSection } from './sections/OrganizeSection';

/**
 * Settings. Each section lives in its own file under sections/ and belongs to
 * one session, so parallel work never edits the same file. Add a new section
 * file and one line here.
 */
export function SettingsScreen() {
  return (
    <Screen title="Settings" testID="screen-settings">
      <AppearanceSection />
      <DisplaySection />
      <ExchangeRatesSection />
      <MoneyPoliciesSection />
      <BudgetsSection />
      <OrganizeSection />
      <AiSection />
      <BackendSection />
      <Card>
        <VStack gap="xs">
          <Text variant="bodyStrong">{`Billionaire ${Constants.expoConfig?.version ?? ''}`}</Text>
          <Text variant="caption" tone="muted">
            With no backend set, the app shows made-up sample data and nothing leaves this device.
          </Text>
        </VStack>
      </Card>
    </Screen>
  );
}
