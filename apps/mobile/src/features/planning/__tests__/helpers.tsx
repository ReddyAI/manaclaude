import type { ReactElement } from 'react';
import { render } from '@testing-library/react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';

/** Screens with charts need the gesture root that the real app layout provides. */
export function renderScreen(ui: ReactElement) {
  return render(<GestureHandlerRootView>{ui}</GestureHandlerRootView>);
}
