import { useMemo } from 'react';
import type { Category } from '@manaclaude/shared';
import { BottomSheet } from '../../design/components/BottomSheet';
import { IconBadge } from '../../design/components/Decor';
import { Icon } from '../../design/components/Icon';
import { ListRow } from '../../design/components/ListRow';
import { useFinanceSelector } from '../../data/store';

/**
 * Pick a category from a sheet. Expense categories come first because most
 * transactions are spending; income and transfer categories follow.
 */
export function CategoryPicker({
  visible,
  onClose,
  onPick,
  selectedId,
  title = 'Category',
  kinds,
}: {
  visible: boolean;
  onClose: () => void;
  onPick: (category: Category) => void;
  selectedId?: string | null;
  title?: string;
  /** Limit the list, for example to expense categories. */
  kinds?: readonly Category['kind'][];
}) {
  const categories = useFinanceSelector((d) => d.categories);
  const sorted = useMemo(() => {
    const rank = { expense: 0, income: 1, transfer: 2 } as const;
    return categories
      .filter((c) => !c.archived && (!kinds || kinds.includes(c.kind)))
      .sort(
        (a, b) => rank[a.kind] - rank[b.kind] || a.order - b.order || a.name.localeCompare(b.name),
      );
  }, [categories, kinds]);

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title={title}
      scrollable
      testID="category-picker"
    >
      {sorted.map((c) => (
        <ListRow
          key={c.id}
          title={c.name}
          leading={<IconBadge icon={c.icon} color={c.color} size="sm" />}
          trailing={c.id === selectedId ? <Icon name="check" size="sm" tone="accent" /> : undefined}
          onPress={() => onPick(c)}
          testID={`category-${c.id}`}
        />
      ))}
    </BottomSheet>
  );
}
