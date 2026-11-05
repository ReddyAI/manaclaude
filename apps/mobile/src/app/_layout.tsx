import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from '@expo-google-fonts/inter';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useState } from 'react';
import { useColorScheme } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { UnistylesRuntime, useUnistyles } from 'react-native-unistyles';
import { loadSettings, useSettings } from '../data/settingsStore';
import { themeNameFor } from '../design/themes';
import { BackendStatusBanner } from '../features/backend/BackendStatusBanner';
import { ReceiptShareHandler } from '../features/transactions/ReceiptShareHandler';

SplashScreen.preventAutoHideAsync().catch(() => {});

/** Applies the saved look and light/dark choice to Unistyles. */
function useAppearance(ready: boolean) {
  const { look, colorScheme } = useSettings();
  const system = useColorScheme();
  const scheme = colorScheme === 'system' ? (system === 'light' ? 'light' : 'dark') : colorScheme;
  useEffect(() => {
    if (!ready) return;
    UnistylesRuntime.setTheme(themeNameFor(look, scheme));
  }, [ready, look, scheme]);
}

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const ready = (fontsLoaded || fontError !== null) && settingsLoaded;
  const { theme } = useUnistyles();

  useEffect(() => {
    loadSettings().finally(() => setSettingsLoaded(true));
  }, []);
  useAppearance(settingsLoaded);
  useEffect(() => {
    if (ready) SplashScreen.hideAsync().catch(() => {});
  }, [ready]);
  useEffect(() => {
    UnistylesRuntime.setRootViewBackgroundColor(theme.colors.canvas);
  }, [theme.colors.canvas]);

  const navTheme = useMemo(() => {
    const base = theme.scheme === 'dark' ? DarkTheme : DefaultTheme;
    return {
      ...base,
      dark: theme.scheme === 'dark',
      colors: {
        ...base.colors,
        primary: theme.colors.accent,
        background: theme.colors.canvas,
        card: theme.colors.surface,
        text: theme.colors.text,
        border: theme.colors.border,
        notification: theme.colors.spending,
      },
    };
  }, [theme]);

  if (!ready) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: theme.colors.canvas }}>
      <ThemeProvider value={navTheme}>
        <StatusBar style={theme.scheme === 'dark' ? 'light' : 'dark'} />
        <Stack
          screenOptions={{
            headerShown: false,
            contentStyle: { backgroundColor: theme.colors.canvas },
          }}
        />
        <ReceiptShareHandler />
        <BackendStatusBanner />
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}
