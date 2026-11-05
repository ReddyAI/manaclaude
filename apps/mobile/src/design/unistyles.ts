import { StyleSheet } from 'react-native-unistyles';
import { breakpoints, themes } from './themes';

type AppThemes = typeof themes;
type AppBreakpoints = typeof breakpoints;

declare module 'react-native-unistyles' {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  export interface UnistylesThemes extends AppThemes {}
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  export interface UnistylesBreakpoints extends AppBreakpoints {}
}

StyleSheet.configure({
  themes,
  breakpoints,
  settings: {
    // The saved look is applied right after settings load (see data/settingsStore.ts),
    // while the splash screen is still up.
    initialTheme: 'midnight-dark',
  },
});
