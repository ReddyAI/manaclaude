import Constants from 'expo-constants';
import { Card } from '../../design/components/Card';
import { VStack } from '../../design/components/Layout';
import { Screen } from '../../design/components/Screen';
import { Text } from '../../design/components/Text';
import { AiSection } from './sections/AiSection';
import { AppearanceSection } from './sections/AppearanceSection';
import { BudgetsSection } from './sections/BudgetsSection';
import { DisplaySection } from './sections/DisplaySection';
import { MoneyPoliciesSection } from './sections/MoneyPoliciesSection';

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
      <MoneyPoliciesSection />
      <BudgetsSection />
      <AiSection />
      <Card>
        <VStack gap="xs">
          <Text variant="bodyStrong">{`Mana ${Constants.expoConfig?.version ?? ''}`}</Text>
          <Text variant="caption" tone="muted">
            Showing made-up sample data. Nothing leaves this device yet.
          </Text>
        </VStack>
      </Card>
    </Screen>
  );
}
