import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';
import { UnistylesRuntime } from 'react-native-unistyles';

/**
 * The one haptics helper. Call `haptic('confirm')` and friends; never call
 * expo-haptics directly from screens.
 *
 * Android uses performAndroidHapticsAsync (Confirm on review, Segment_Tick
 * while scrubbing a chart, Toggle_On/Toggle_Off on switches, Reject on
 * errors). iOS uses impactAsync / selectionAsync / notificationAsync.
 * Web has no haptics.
 */
export type HapticEvent =
  | 'confirm'
  | 'reject'
  | 'tick'
  | 'toggleOn'
  | 'toggleOff'
  | 'tap'
  | 'longPress'
  | 'selection';

let enabled = true;

/** Wired to Settings > Haptics by the settings store. */
export function setHapticsEnabled(value: boolean): void {
  enabled = value;
}

export function hapticsEnabled(): boolean {
  return enabled;
}

const ANDROID: Record<HapticEvent, Haptics.AndroidHaptics> = {
  confirm: Haptics.AndroidHaptics.Confirm,
  reject: Haptics.AndroidHaptics.Reject,
  tick: Haptics.AndroidHaptics.Segment_Tick,
  toggleOn: Haptics.AndroidHaptics.Toggle_On,
  toggleOff: Haptics.AndroidHaptics.Toggle_Off,
  tap: Haptics.AndroidHaptics.Virtual_Key,
  longPress: Haptics.AndroidHaptics.Long_Press,
  selection: Haptics.AndroidHaptics.Segment_Tick,
};

const IMPACT: Record<'light' | 'medium' | 'heavy', Haptics.ImpactFeedbackStyle> = {
  light: Haptics.ImpactFeedbackStyle.Light,
  medium: Haptics.ImpactFeedbackStyle.Medium,
  heavy: Haptics.ImpactFeedbackStyle.Heavy,
};

function ios(event: HapticEvent, impact: 'light' | 'medium' | 'heavy'): Promise<void> {
  switch (event) {
    case 'confirm':
      return Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    case 'reject':
      return Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    case 'tick':
    case 'selection':
      return Haptics.selectionAsync();
    case 'longPress':
      return Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    default:
      return Haptics.impactAsync(IMPACT[impact]);
  }
}

export function haptic(event: HapticEvent): void {
  if (!enabled || Platform.OS === 'web') return;
  const { haptics } = UnistylesRuntime.getTheme();
  if (event === 'tick' && !haptics.scrubTicks) return;
  const run =
    Platform.OS === 'android' ? Haptics.performAndroidHapticsAsync(ANDROID[event]) : ios(event, haptics.impact);
  run.catch(() => {
    // Some devices have no vibrator; haptics are a nicety, never an error.
  });
}
