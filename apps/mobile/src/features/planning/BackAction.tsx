import { IconButton } from '../../design/components/Button';
import { goBack } from './navigate';

/** Back button for screens that are pushed on top of the tabs (investments, planning, recaps). */
export function BackAction({ fallback = '/networth' }: { fallback?: string }) {
  return (
    <IconButton
      icon="chevron-left"
      accessibilityLabel="Back"
      testID="back-action"
      onPress={() => goBack(fallback)}
    />
  );
}
