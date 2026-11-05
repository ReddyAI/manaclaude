import { useEffect, useState, type ReactNode } from 'react';
import { Modal, Pressable, ScrollView, View } from 'react-native';
import {
  GestureDetector,
  GestureHandlerRootView,
  usePanGesture,
} from 'react-native-gesture-handler';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from 'react-native-reanimated';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Text } from './Text';

export interface BottomSheetProps {
  visible: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  /** Let the content scroll (long lists). */
  scrollable?: boolean;
  testID?: string;
}

const OFFSCREEN = 800;

/**
 * Sheet that slides up from the bottom; drag down or tap outside to close.
 * Centred dialog-style on wide screens.
 */
export function BottomSheet({
  visible,
  onClose,
  title,
  children,
  scrollable = false,
  testID,
}: BottomSheetProps) {
  const { theme } = useUnistyles();
  const [mounted, setMounted] = useState(visible);
  // Mount as soon as it should show (derived state, set during render).
  if (visible && !mounted) setMounted(true);
  const translateY = useSharedValue(OFFSCREEN);
  const backdrop = useSharedValue(0);

  useEffect(() => {
    if (visible) {
      translateY.set(withSpring(0, theme.motion.spring));
      backdrop.set(withTiming(1, { duration: theme.motion.normal }));
      return undefined;
    }
    backdrop.set(withTiming(0, { duration: theme.motion.fast }));
    translateY.set(withTiming(OFFSCREEN, { duration: theme.motion.normal }));
    const t = setTimeout(() => setMounted(false), theme.motion.normal);
    return () => clearTimeout(t);
  }, [visible, theme.motion, translateY, backdrop]);

  const pan = usePanGesture({
    runOnJS: true,
    activeOffsetY: 8,
    onUpdate: (e) => {
      translateY.set(Math.max(0, e.translationY));
    },
    onDeactivate: (e) => {
      if (e.translationY > 120 || e.velocityY > 900) onClose();
      else translateY.set(withSpring(0, theme.motion.spring));
    },
  });

  const sheetStyle = useAnimatedStyle(() => ({ transform: [{ translateY: translateY.get() }] }));
  const backdropStyle = useAnimatedStyle(() => ({ opacity: backdrop.get() }));

  if (!mounted) return null;
  const body = scrollable ? <ScrollView style={styles.scroll}>{children}</ScrollView> : children;

  return (
    <Modal
      transparent
      visible
      animationType="none"
      onRequestClose={onClose}
      statusBarTranslucent
      navigationBarTranslucent
    >
      <GestureHandlerRootView style={styles.fill}>
        <Animated.View style={[styles.backdropWrap, backdropStyle]}>
          <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close" />
        </Animated.View>
        <View style={styles.anchor} pointerEvents="box-none">
          <Animated.View style={[styles.sheetWrap, sheetStyle]}>
            <View style={styles.sheet} testID={testID}>
              <GestureDetector gesture={pan}>
                <View style={styles.handleArea}>
                  <View style={styles.handle} />
                  {title ? (
                    <Text variant="headline" align="center">
                      {title}
                    </Text>
                  ) : null}
                </View>
              </GestureDetector>
              {body}
            </View>
          </Animated.View>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create((theme, rt) => ({
  fill: { flex: 1 },
  backdropWrap: { ...StyleSheet.absoluteFillObject },
  backdrop: { flex: 1, backgroundColor: theme.colors.overlay },
  anchor: {
    flex: 1,
    justifyContent: { xs: 'flex-end', md: 'center' },
    alignItems: 'center',
  },
  sheetWrap: {
    width: '100%',
    maxWidth: { xs: undefined, md: theme.size.sheetMaxWidth },
    maxHeight: '90%',
  },
  sheet: {
    backgroundColor: theme.colors.surfaceRaised,
    borderTopLeftRadius: theme.radius.xl,
    borderTopRightRadius: theme.radius.xl,
    borderBottomLeftRadius: { xs: 0, md: theme.radius.xl },
    borderBottomRightRadius: { xs: 0, md: theme.radius.xl },
    paddingBottom: rt.insets.bottom + theme.space.lg,
    paddingHorizontal: theme.space.lg,
    gap: theme.space.md,
    boxShadow: `0px -4px 24px ${theme.colors.shadow}`,
  },
  scroll: { maxHeight: rt.screen.height * 0.7 },
  handleArea: { alignItems: 'center', paddingTop: theme.space.sm, gap: theme.space.sm },
  handle: {
    width: theme.size.sheetHandleWidth,
    height: theme.size.sheetHandleHeight,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.borderStrong,
  },
}));
