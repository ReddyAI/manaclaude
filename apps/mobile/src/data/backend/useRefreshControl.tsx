import { useState } from 'react';
import { RefreshControl } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { refreshDataset } from './sync';

/** Pull to refresh for screens that show backend data: reloads GET /v1/dataset. */
export function useRefreshControl() {
  const { theme } = useUnistyles();
  const [pulling, setPulling] = useState(false);
  return (
    <RefreshControl
      refreshing={pulling}
      tintColor={theme.colors.accent}
      colors={[theme.colors.accent]}
      onRefresh={() => {
        setPulling(true);
        void refreshDataset().finally(() => setPulling(false));
      }}
    />
  );
}
