import { Tabs } from 'expo-router/js-tabs';
import { useWindowDimensions } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { breakpoints } from '../../design/themes';
import { TabBar } from '../../navigation/TabBar';
import { TABS } from '../../navigation/tabs';

export default function TabsLayout() {
  const { theme } = useUnistyles();
  const { width } = useWindowDimensions();
  const wide = width >= breakpoints.md;
  return (
    <Tabs
      tabBar={(props) => (
        <TabBar state={props.state} navigateToTab={props.navigateToTab} wide={wide} />
      )}
      screenOptions={{
        headerShown: false,
        tabBarPosition: wide ? 'left' : 'bottom',
        sceneStyle: { backgroundColor: theme.colors.canvas },
        animation: 'fade',
      }}
    >
      {TABS.map((t) => (
        <Tabs.Screen key={t.name} name={t.name} options={{ title: t.title }} />
      ))}
    </Tabs>
  );
}
