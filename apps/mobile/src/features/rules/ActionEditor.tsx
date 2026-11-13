import { useState } from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { Button } from '../../design/components/Button';
import { Chip, TextField } from '../../design/components/Controls';
import { HStack, VStack } from '../../design/components/Layout';
import { Text } from '../../design/components/Text';
import { useFinanceSelector } from '../../data/store';
import { CategoryPicker } from '../transactions/CategoryPicker';
import { ACTION_TYPES, KINDS, newAction, type ActionDraft, type ActionType } from './rules';

/** One action of the rule form. `taken` lists types another action of this rule already has. */
export function ActionEditor({
  draft,
  index,
  taken,
  problem,
  onChange,
  onRemove,
}: {
  draft: ActionDraft;
  index: number;
  taken: readonly ActionType[];
  problem: string | null;
  onChange: (d: ActionDraft) => void;
  onRemove: () => void;
}) {
  const tags = useFinanceSelector((d) => d.tags);
  const categories = useFinanceSelector((d) => d.categories);
  const [picking, setPicking] = useState(false);
  const types = ACTION_TYPES.filter((t) => t.type === draft.type || !taken.includes(t.type));

  return (
    <View style={styles.box} testID={`act-${index}`}>
      <VStack gap="sm">
        <HStack gap="xs" wrap>
          {types.map((t) => (
            <Chip
              key={t.type}
              label={t.label}
              selected={draft.type === t.type}
              onPress={() =>
                draft.type !== t.type && onChange({ ...newAction(t.type), key: draft.key })
              }
              testID={`act-${index}-type-${t.type}`}
            />
          ))}
        </HStack>
        {draft.type === 'set_category' ? (
          <>
            <Button
              label={
                draft.categoryId
                  ? (categories.find((c) => c.id === draft.categoryId)?.name ??
                    'A category not on this device')
                  : 'Pick a category'
              }
              variant="secondary"
              onPress={() => setPicking(true)}
              testID={`act-${index}-category`}
            />
            <CategoryPicker
              visible={picking}
              onClose={() => setPicking(false)}
              selectedId={draft.categoryId}
              onPick={(c) => {
                setPicking(false);
                onChange({ ...draft, categoryId: c.id });
              }}
            />
          </>
        ) : draft.type === 'set_name' ? (
          <TextField
            label="New name"
            value={draft.name}
            onChangeText={(name) => onChange({ ...draft, name })}
            testID={`act-${index}-name`}
          />
        ) : draft.type === 'set_kind' ? (
          <HStack gap="xs" wrap>
            {KINDS.map((k) => (
              <Chip
                key={k.kind}
                label={k.label}
                selected={draft.kind === k.kind}
                onPress={() => onChange({ ...draft, kind: k.kind })}
                testID={`act-${index}-kind-${k.kind}`}
              />
            ))}
          </HStack>
        ) : draft.type === 'add_tag' ? (
          tags.length === 0 ? (
            <Text variant="caption" tone="muted" testID={`act-${index}-no-tags`}>
              There are no tags yet, and the Worker has no way to make one from here.
            </Text>
          ) : (
            <HStack gap="xs" wrap>
              {tags.map((t) => (
                <Chip
                  key={t.id}
                  label={t.name}
                  selected={draft.tagId === t.id}
                  onPress={() => onChange({ ...draft, tagId: t.id })}
                  testID={`act-${index}-tag-${t.id}`}
                />
              ))}
            </HStack>
          )
        ) : draft.type === 'exclude' ? (
          <Text variant="caption" tone="muted">
            The transaction stays in its account but counts in no report or budget.
          </Text>
        ) : null}
        {problem ? (
          <Text variant="caption" tone="danger" testID={`act-${index}-problem`}>
            {problem}
          </Text>
        ) : null}
        <HStack justify="flex-end">
          <Button
            label="Remove"
            size="sm"
            variant="ghost"
            onPress={onRemove}
            testID={`act-${index}-remove`}
          />
        </HStack>
      </VStack>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  box: {
    padding: theme.space.md,
    borderRadius: theme.radius.md,
    borderWidth: theme.size.hairline,
    borderColor: theme.colors.border,
  },
}));
