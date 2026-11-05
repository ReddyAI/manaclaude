/* Test setup: mocks for native modules that have no JS implementation in Jest. */
import 'react-native-gesture-handler/jestSetup';
import 'react-native-unistyles/mocks';
import { themes } from './src/design/themes';

// Reanimated 4 needs its native runtime; tests use a small stand-in that
// covers what the design system calls (shared values, animated styles, timing).
jest.mock('react-native-worklets', () => ({
  scheduleOnRN: (fn: () => void) => fn(),
  runOnJS: (fn: unknown) => fn,
}));
jest.mock('react-native-reanimated', () => {
  const { View, Text, ScrollView, Image } = require('react-native');
  const sharedValue = <T>(initial: T) => {
    const sv = { value: initial, get: () => sv.value, set: (v: T) => (sv.value = v) };
    return sv;
  };
  const Animated = {
    View,
    Text,
    ScrollView,
    Image,
    createAnimatedComponent: <C>(c: C) => c,
  };
  return {
    __esModule: true,
    default: Animated,
    ...Animated,
    useSharedValue: sharedValue,
    isSharedValue: (v: unknown) => typeof v === 'object' && v !== null && 'get' in v && 'set' in v,
    useAnimatedStyle: (fn: () => object) => fn(),
    useDerivedValue: (fn: () => unknown) => sharedValue(fn()),
    withTiming: <T>(v: T) => v,
    withSpring: <T>(v: T) => v,
    withDelay: <T>(_d: number, v: T) => v,
    Easing: {
      linear: (t: number) => t,
      ease: (t: number) => t,
      out: (f: unknown) => f,
      inOut: (f: unknown) => f,
    },
  };
});

jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

jest.mock('expo-haptics', () => {
  const actual = jest.requireActual('expo-haptics');
  return {
    ...actual,
    performAndroidHapticsAsync: jest.fn(() => Promise.resolve()),
    impactAsync: jest.fn(() => Promise.resolve()),
    selectionAsync: jest.fn(() => Promise.resolve()),
    notificationAsync: jest.fn(() => Promise.resolve()),
  };
});

// Register the real themes with the Unistyles mock so styles resolve to real tokens.
require('./src/design/unistyles');
void themes;
