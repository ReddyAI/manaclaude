import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { BottomSheet } from '../design/components/BottomSheet';
import { Icon } from '../design/components/Icon';
import { ListRow } from '../design/components/ListRow';
import { Text } from '../design/components/Text';
import { haptic } from '../design/haptics';
import { TABS, type TabDef } from './tabs';

interface TabBarProps {
  state: { index: number; routes: { key: string; name: string }[] };
  navigateToTab: (routeKey: string) => void;
  wide: boolean;
}

/** Bottom bar on phones, sidebar on wide screens. */
export function TabBar({ state, navigateToTab, wide }: TabBarProps) {
  const [moreOpen, setMoreOpen] = useState(false);
  const activeName = state.routes[state.index]?.name;
  const go = (tab: TabDef) => {
    const route = state.routes.find((r) => r.name === tab.name);
    if (!route) return;
    if (route.name !== activeName) haptic('selection');
    navigateToTab(route.key);
  };

  if (wide) {
    return (
      <View style={styles.sidebar} accessibilityRole="tablist">
        <Text variant="headline" style={styles.brand}>
          Mana
        </Text>
        {TABS.map((tab) => {
          const active = tab.name === activeName;
          return (
            <Pressable
              key={tab.name}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              accessibilityLabel={tab.title}
              onPress={() => go(tab)}
              style={styles.sideItem(active)}
              testID={`tab-${tab.name}`}
            >
              <Icon name={tab.icon} size="md" tone={active ? 'default' : 'muted'} />
              <Text variant="bodyStrong" tone={active ? 'default' : 'muted'}>
                {tab.title}
              </Text>
            </Pressable>
          );
        })}
      </View>
    );
  }

  const primary = TABS.filter((t) => t.primary);
  const more = TABS.filter((t) => !t.primary);
  const moreActive = more.some((t) => t.name === activeName);

  return (
    <View style={styles.bottom} accessibilityRole="tablist">
      {primary.map((tab) => {
        const active = tab.name === activeName;
        return (
          <Pressable
            key={tab.name}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={tab.title}
            onPress={() => go(tab)}
            style={styles.bottomItem}
            testID={`tab-${tab.name}`}
          >
            <View style={styles.indicator(active)}>
              <Icon name={tab.icon} size="md" tone={active ? 'default' : 'faint'} />
            </View>
            <Text variant="micro" tone={active ? 'default' : 'faint'}>
              {tab.title}
            </Text>
          </Pressable>
        );
      })}
      <Pressable
        accessibilityRole="tab"
        accessibilityState={{ selected: moreActive }}
        accessibilityLabel="More"
        onPress={() => {
          haptic('selection');
          setMoreOpen(true);
        }}
        style={styles.bottomItem}
        testID="tab-more"
      >
        <View style={styles.indicator(moreActive)}>
          <Icon name="ellipsis" size="md" tone={moreActive ? 'default' : 'faint'} />
        </View>
        <Text variant="micro" tone={moreActive ? 'default' : 'faint'}>
          More
        </Text>
      </Pressable>
      <BottomSheet visible={moreOpen} onClose={() => setMoreOpen(false)} title="More">
        <View>
          {more.map((tab) => (
            <ListRow
              key={tab.name}
              title={tab.title}
              leading={<Icon name={tab.icon} size="md" tone="muted" />}
              showChevron
              onPress={() => {
                setMoreOpen(false);
                go(tab);
              }}
            />
          ))}
        </View>
      </BottomSheet>
    </View>
  );
}

const styles = StyleSheet.create((theme, rt) => ({
  bottom: {
    flexDirection: 'row',
    backgroundColor: theme.colors.tabBar,
    borderTopWidth: theme.size.hairline,
    borderTopColor: theme.colors.border,
    paddingBottom: rt.insets.bottom,
    minHeight: theme.size.tabBarHeight + rt.insets.bottom,
  },
  bottomItem: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.space.xxs,
    paddingVertical: theme.space.sm,
  },
  indicator: (active: boolean) => ({
    paddingHorizontal: theme.space.lg,
    paddingVertical: theme.space.xxs,
    borderRadius: theme.radius.pill,
    backgroundColor: active ? theme.colors.accentMuted : 'transparent',
  }),
  sidebar: {
    width: theme.size.sidebarWidth,
    backgroundColor: theme.colors.tabBar,
    borderRightWidth: theme.size.hairline,
    borderRightColor: theme.colors.border,
    paddingTop: rt.insets.top + theme.space.xl,
    paddingHorizontal: theme.space.md,
    gap: theme.space.xxs,
  },
  brand: { paddingHorizontal: theme.space.md, paddingBottom: theme.space.lg },
  sideItem: (active: boolean) => ({
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.md,
    paddingHorizontal: theme.space.md,
    minHeight: theme.size.touchTarget,
    borderRadius: theme.radius.md,
    backgroundColor: active ? theme.colors.accentMuted : 'transparent',
  }),
}));
