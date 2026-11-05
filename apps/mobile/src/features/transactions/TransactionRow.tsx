import type { ReactNode } from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { IconBadge } from '../../design/components/Decor';
import { ListRow } from '../../design/components/ListRow';
import type { Lookups } from '../../data/selectors';
import { Amount } from '../currency/Amount';
import type { TransactionListRow } from './display';

export function TransactionRow({
  row,
  lookups,
  onPress,
  caption,
}: {
  row: TransactionListRow;
  lookups: Lookups;
  onPress?: () => void;
  /** Small element under the amount, such as the AI confidence. */
  caption?: ReactNode;
}) {
  const { txn, transfer } = row;
  const category = txn.categoryId ? lookups.categoriesById.get(txn.categoryId) : undefined;
  const leading = transfer ? (
    <IconBadge icon="link" color="c9" />
  ) : (
    <View>
      <IconBadge icon={category?.icon ?? 'circle'} color={category?.color ?? 'c12'} />
      {!txn.reviewed ? <View style={styles.unreviewed} accessibilityLabel="Not reviewed" /> : null}
    </View>
  );
  return (
    <ListRow
      title={row.title}
      subtitle={row.subtitle}
      leading={leading}
      onPress={onPress}
      testID={`txn-${txn.id}`}
      accessibilityLabel={`${row.title}, ${row.subtitle}`}
      trailing={
        <View style={styles.trailing}>
          <Amount
            amount={transfer ? Math.abs(txn.amount) : txn.amount}
            currency={txn.currency}
            date={txn.date}
            colorize={transfer ? 'none' : 'flow'}
            tone={transfer ? 'muted' : undefined}
          />
          {caption}
        </View>
      }
    />
  );
}

const styles = StyleSheet.create((theme) => ({
  trailing: { alignItems: 'flex-end', gap: theme.space.xxs },
  unreviewed: {
    position: 'absolute',
    top: 0,
    right: 0,
    width: theme.size.dot,
    height: theme.size.dot,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.accent,
    borderWidth: theme.size.hairline,
    borderColor: theme.colors.canvas,
  },
}));
