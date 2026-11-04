import { router } from 'expo-router';
import { Button } from '../design/components/Button';
import { EmptyState } from '../design/components/Decor';
import { Screen } from '../design/components/Screen';

export default function NotFound() {
  return (
    <Screen title="Not found">
      <EmptyState icon="triangle-alert" title="This page doesn't exist." />
      <Button label="Go home" onPress={() => router.replace('/')} variant="secondary" />
    </Screen>
  );
}
