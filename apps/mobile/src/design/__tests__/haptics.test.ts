import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';
import { UnistylesRuntime } from 'react-native-unistyles';
import { haptic, setHapticsEnabled } from '../haptics';
import { themes } from '../themes';

function setPlatform(os: 'android' | 'ios' | 'web') {
  Object.defineProperty(Platform, 'OS', { value: os, configurable: true });
}

describe('haptic()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setHapticsEnabled(true);
    jest.spyOn(UnistylesRuntime, 'getTheme').mockReturnValue(themes['midnight-dark'] as never);
  });

  it('uses performAndroidHapticsAsync on Android', () => {
    setPlatform('android');
    haptic('confirm');
    haptic('tick');
    haptic('toggleOn');
    haptic('toggleOff');
    haptic('reject');
    expect((Haptics.performAndroidHapticsAsync as jest.Mock).mock.calls.map((c) => c[0])).toEqual([
      Haptics.AndroidHaptics.Confirm,
      Haptics.AndroidHaptics.Segment_Tick,
      Haptics.AndroidHaptics.Toggle_On,
      Haptics.AndroidHaptics.Toggle_Off,
      Haptics.AndroidHaptics.Reject,
    ]);
  });

  it('uses impact and selection feedback on iOS', () => {
    setPlatform('ios');
    haptic('tick');
    haptic('tap');
    expect(Haptics.selectionAsync).toHaveBeenCalledTimes(1);
    expect(Haptics.impactAsync).toHaveBeenCalledWith(Haptics.ImpactFeedbackStyle.Light);
  });

  it('does nothing when turned off in Settings or on web', () => {
    setPlatform('android');
    setHapticsEnabled(false);
    haptic('confirm');
    setHapticsEnabled(true);
    setPlatform('web');
    haptic('confirm');
    expect(Haptics.performAndroidHapticsAsync).not.toHaveBeenCalled();
  });

  it('skips scrub ticks in looks that turn them off', () => {
    setPlatform('android');
    jest.spyOn(UnistylesRuntime, 'getTheme').mockReturnValue(themes['compact-light'] as never);
    haptic('tick');
    haptic('confirm');
    expect(Haptics.performAndroidHapticsAsync).toHaveBeenCalledTimes(1);
  });
});
