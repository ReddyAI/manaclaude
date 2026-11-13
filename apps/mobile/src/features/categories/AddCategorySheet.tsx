import { COLOR_SLOTS, type Category, type CategoryIcon, type ColorSlot } from '@manaclaude/shared';
import { useRef, useState } from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { BottomSheet } from '../../design/components/BottomSheet';
import { Button } from '../../design/components/Button';
import { Chip, Switch, TextField } from '../../design/components/Controls';
import { Icon } from '../../design/components/Icon';
import { HStack, VStack } from '../../design/components/Layout';
import { Text } from '../../design/components/Text';
import { errorText, isSuperseded } from '../../data/backend/client';
import { useBackendStatus } from '../../data/backend/status';
import { canSaveToBackend } from '../../data/backend/sync';
import { addCategory } from './actions';
import {
  CATEGORY_ICONS,
  CATEGORY_NAME_MAX,
  KIND_LABEL,
  freeColor,
  nameProblem,
  orderAtEnd,
  type CategorySection,
} from './categories';

/**
 * A new category in one of the groups the Worker already has (POST
 * /v1/categories). Its kind is the group's kind. Icon and colour can only be
 * chosen here: the Worker has no way to change them later.
 */
export function AddCategorySheet({
  visible,
  sections,
  categories,
  onClose,
}: {
  visible: boolean;
  sections: readonly CategorySection[];
  categories: readonly Category[];
  onClose: () => void;
}) {
  useBackendStatus();
  const [open, setOpen] = useState(visible);
  const [name, setName] = useState('');
  const [groupId, setGroupId] = useState<string | null>(null);
  const [color, setColor] = useState<ColorSlot | null>(null);
  const [icon, setIcon] = useState<CategoryIcon>('tag');
  const [excludeFromBudget, setExclude] = useState(false);
  const [busy, setBusy] = useState(false);
  // Set at once on a tap, so a fast second tap cannot add the category twice.
  const sending = useRef(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (visible !== open) {
    setOpen(visible);
    if (visible) {
      setName('');
      setGroupId(null);
      setColor(null);
      setIcon('tag');
      setExclude(false);
      setProblem(null);
    }
  }

  // Group ids come from the data loaded from this backend. Sample data's groups are not the Worker's.
  const live = canSaveToBackend();
  const groups = sections.filter((s) => s.known && s.kind !== null);
  const group = groups.find((s) => s.groupId === groupId) ?? null;
  const nameError = group ? nameProblem(name, categories, group.groupId) : null;
  const chosenColor = color ?? (group ? freeColor(group.active) : 'c1');

  const save = async () => {
    if (!group || !group.kind || nameError || sending.current) return;
    sending.current = true;
    setBusy(true);
    setProblem(null);
    try {
      await addCategory({
        name: name.trim(),
        groupId: group.groupId,
        kind: group.kind,
        icon,
        color: chosenColor,
        excludeFromBudget,
        order: orderAtEnd(group.active),
      });
      onClose();
    } catch (e) {
      if (!isSuperseded(e)) setProblem(errorText(e));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  return (
    <BottomSheet
      visible={visible}
      onClose={onClose}
      title="Add a category"
      scrollable
      testID="category-add-sheet"
    >
      {!live ? (
        <Text variant="body" tone="muted" testID="category-add-not-loaded">
          Your data from this backend has not loaded yet, so its groups are not known. Pull down on
          Home to load it, then try again.
        </Text>
      ) : (
        <VStack gap="lg">
          <TextField
            label="Name"
            value={name}
            onChangeText={setName}
            maxLength={CATEGORY_NAME_MAX + 20}
            error={name.trim() && nameError ? nameError : undefined}
            testID="category-add-name"
          />
          <VStack gap="sm">
            <Text variant="label" tone="muted">
              Group
            </Text>
            <HStack gap="xs" wrap>
              {groups.map((g) => (
                <Chip
                  key={g.groupId}
                  label={g.title}
                  selected={g.groupId === groupId}
                  onPress={() => setGroupId(g.groupId)}
                  testID={`category-add-group-${g.groupId}`}
                />
              ))}
            </HStack>
            {group?.kind ? (
              <Text variant="caption" tone="muted" testID="category-add-kind">
                {`Kind: ${KIND_LABEL[group.kind]}, as the group.`}
              </Text>
            ) : null}
          </VStack>
          <VStack gap="sm">
            <Text variant="label" tone="muted">
              Colour
            </Text>
            <HStack gap="xs" wrap>
              {COLOR_SLOTS.map((slot, i) => (
                <Pressable
                  key={slot}
                  accessibilityRole="radio"
                  accessibilityLabel={`Colour ${i + 1}`}
                  accessibilityState={{ checked: slot === chosenColor }}
                  onPress={() => setColor(slot)}
                  testID={`category-add-color-${slot}`}
                >
                  <View style={styles.swatch(slot, slot === chosenColor)} />
                </Pressable>
              ))}
            </HStack>
          </VStack>
          <VStack gap="sm">
            <Text variant="label" tone="muted">
              Icon
            </Text>
            <HStack gap="xs" wrap>
              {CATEGORY_ICONS.map((key) => (
                <Pressable
                  key={key}
                  accessibilityRole="radio"
                  accessibilityLabel={`Icon ${key}`}
                  accessibilityState={{ checked: key === icon }}
                  onPress={() => setIcon(key)}
                  testID={`category-add-icon-${key}`}
                >
                  <View style={styles.iconCell(key === icon)}>
                    <Icon name={key} size="sm" tone={key === icon ? 'accent' : 'muted'} />
                  </View>
                </Pressable>
              ))}
            </HStack>
          </VStack>
          <HStack gap="md" align="center" justify="space-between">
            <Text variant="bodyStrong">Leave out of budgets</Text>
            <Switch
              value={excludeFromBudget}
              onValueChange={setExclude}
              accessibilityLabel="Leave out of budgets"
              testID="category-add-budget"
            />
          </HStack>
          {problem ? (
            <Text variant="caption" tone="danger" testID="category-add-problem">
              {problem}
            </Text>
          ) : null}
          <Button
            label="Add"
            disabled={!group || !name.trim() || nameError !== null}
            loading={busy}
            onPress={() => void save()}
            testID="category-add-save"
          />
        </VStack>
      )}
    </BottomSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  swatch: (slot: ColorSlot, selected: boolean) => ({
    width: theme.size.touchTarget,
    height: theme.size.touchTarget,
    borderRadius: theme.radius.pill,
    backgroundColor: theme.colors.category[slot],
    borderWidth: selected ? theme.size.focusRing : theme.size.hairline,
    borderColor: selected ? theme.colors.text : theme.colors.border,
  }),
  iconCell: (selected: boolean) => ({
    width: theme.size.touchTarget,
    height: theme.size.touchTarget,
    borderRadius: theme.radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: selected ? theme.size.focusRing : theme.size.hairline,
    borderColor: selected ? theme.colors.accent : theme.colors.border,
  }),
}));
