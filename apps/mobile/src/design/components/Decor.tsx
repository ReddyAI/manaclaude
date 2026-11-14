import type { ReactNode } from 'react';
import { View } from 'react-native';
import type { ColorSlot, CategoryIcon as CategoryIconKey } from '@manaclaude/shared';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Button } from './Button';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';

type AvatarSize = 'sm' | 'md' | 'lg';

/** Initials in a tinted circle. Used for institutions; never a real logo. */
export function Avatar({
  label,
  color = 'c1',
  size = 'md',
}: {
  label: string;
  color?: ColorSlot;
  size?: AvatarSize;
}) {
  const initials = label
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
  return (
    <View style={styles.avatar(color, size)}>
      <Text variant={size === 'lg' ? 'headline' : 'micro'} style={styles.avatarText(color)}>
        {initials}
      </Text>
    </View>
  );
}

/** Category or UI icon in a tinted circle. */
export function IconBadge({
  icon,
  color = 'c1',
  size = 'md',
}: {
  icon: CategoryIconKey | IconName;
  color?: ColorSlot;
  size?: AvatarSize;
}) {
  const { theme } = useUnistyles();
  return (
    <View style={styles.avatar(color, size)}>
      <Icon name={icon} size={size === 'lg' ? 'lg' : 'sm'} color={theme.colors.category[color]} />
    </View>
  );
}

export function SectionHeader({
  title,
  action,
  onAction,
  trailing,
}: {
  title: string;
  action?: string;
  onAction?: () => void;
  /** Right-aligned content such as a group total. */
  trailing?: ReactNode;
}) {
  return (
    <View style={styles.section}>
      <Text variant="label" tone="muted" uppercase style={styles.sectionTitle}>
        {title}
      </Text>
      {trailing}
      {action && onAction ? (
        <Text variant="label" tone="accent" onPress={onAction} accessibilityRole="button">
          {action}
        </Text>
      ) : null}
    </View>
  );
}

export function EmptyState({
  icon = 'sparkles',
  title,
  message,
  actionLabel,
  onAction,
  testID,
}: {
  icon?: IconName;
  title: string;
  message?: string;
  actionLabel?: string;
  onAction?: () => void;
  testID?: string;
}) {
  return (
    <View style={styles.empty} testID={testID}>
      <Icon name={icon} size="lg" tone="faint" />
      <Text variant="headline" align="center">
        {title}
      </Text>
      {message ? (
        <Text variant="body" tone="muted" align="center">
          {message}
        </Text>
      ) : null}
      {actionLabel && onAction ? (
        <Button label={actionLabel} onPress={onAction} variant="secondary" size="sm" />
      ) : null}
    </View>
  );
}

/** Notice strip for sample data, sync problems and similar. */
export function Banner({
  tone = 'accent',
  icon = 'info',
  children,
}: {
  tone?: 'accent' | 'pending' | 'danger';
  icon?: IconName;
  children: ReactNode;
}) {
  return (
    <View style={styles.banner(tone)}>
      <Icon name={icon} size="sm" tone={tone} />
      <View style={styles.bannerBody}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  avatar: (color: ColorSlot, size: AvatarSize) => {
    const dim = { sm: theme.size.avatarSm, md: theme.size.avatarMd, lg: theme.size.avatarLg }[size];
    return {
      width: dim,
      height: dim,
      borderRadius: theme.look === 'compact' ? theme.radius.md : theme.radius.pill,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.colors.categoryMuted[color],
    };
  },
  avatarText: (color: ColorSlot) => ({ color: theme.colors.categoryText[color] }),
  section: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: theme.space.lg,
    paddingTop: theme.space.lg,
    paddingBottom: theme.space.sm,
  },
  sectionTitle: { letterSpacing: theme.type.micro.letterSpacing },
  empty: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.space.sm,
    padding: theme.space.xxl,
  },
  banner: (tone: 'accent' | 'pending' | 'danger') => ({
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.space.sm,
    padding: theme.space.md,
    borderRadius: theme.radius.md,
    backgroundColor:
      tone === 'pending'
        ? theme.colors.pendingMuted
        : tone === 'danger'
          ? theme.colors.dangerMuted
          : theme.colors.accentMuted,
  }),
  bannerBody: { flex: 1, gap: theme.space.xxs },
}));
