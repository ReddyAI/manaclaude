import { useMemo, useState } from 'react';
import { View } from 'react-native';
import { currencyInfo, todayLocal, type Category } from '@manaclaude/shared';
import { StyleSheet } from 'react-native-unistyles';
import { BottomSheet } from '../../design/components/BottomSheet';
import { Button, IconButton } from '../../design/components/Button';
import { SegmentedControl } from '../../design/components/Controls';
import { EmptyState, IconBadge } from '../../design/components/Decor';
import { Icon } from '../../design/components/Icon';
import { HStack, VStack } from '../../design/components/Layout';
import { PressableScale } from '../../design/components/PressableScale';
import { Text } from '../../design/components/Text';
import { haptic } from '../../design/haptics';
import { useSettings } from '../../data/settingsStore';
import { useFinance } from '../../data/store';
import { addCashTransaction } from './actions';
import {
  PAD_KEYS,
  padAmount,
  padDisplay,
  padReduce,
  pickCashAccount,
  quickAddCategories,
  quickAddCurrency,
  type CashDirection,
  type PadKey,
} from './cash';

/**
 * Cash quick-add (session A): the + button opens a number pad first, then the
 * category. It goes to the default cash account in the display currency
 * (USD or INR; Both and Native use the main currency).
 */
export function CashQuickAddButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <View style={styles.fabWrap} pointerEvents="box-none">
        <PressableScale
          onPress={() => setOpen(true)}
          pressHaptic="tap"
          accessibilityLabel="Add cash transaction"
          testID="cash-quick-add"
        >
          <View style={styles.fab}>
            <Icon name="plus" size="lg" tone="onAccent" />
          </View>
        </PressableScale>
      </View>
      <CashQuickAddSheet visible={open} onClose={() => setOpen(false)} />
    </>
  );
}

export function CashQuickAddSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const data = useFinance();
  const { displayCurrencyMode, primaryCurrency } = useSettings();
  const currency = quickAddCurrency(displayCurrencyMode, primaryCurrency);
  const account = useMemo(
    () => pickCashAccount(data.accounts, currency),
    [data.accounts, currency],
  );
  const [step, setStep] = useState<'amount' | 'category'>('amount');
  const [value, setValue] = useState('');
  const [direction, setDirection] = useState<CashDirection>('expense');
  const categories = useMemo(
    () => quickAddCategories(data, direction, todayLocal()),
    [data, direction],
  );
  const amount = padAmount(value, currency);

  const reset = () => {
    setStep('amount');
    setValue('');
    setDirection('expense');
  };
  const close = () => {
    onClose();
    reset();
  };
  const press = (key: PadKey) => setValue((v) => padReduce(v, key, currency));
  const pick = (category: Category) => {
    if (!account) return;
    addCashTransaction({
      accountId: account.id,
      amount,
      direction,
      categoryId: category.id,
    });
    haptic('confirm');
    close();
  };

  return (
    <BottomSheet
      visible={visible}
      onClose={close}
      title={step === 'amount' ? 'Add cash' : 'Pick a category'}
      scrollable
      testID="cash-sheet"
    >
      {!account ? (
        <EmptyState
          icon="wallet"
          title={`No ${currency} cash account`}
          message={`Add a cash account in ${currency} on the Accounts screen to log cash here.`}
        />
      ) : (
        <VStack gap="md">
          <VStack gap="xxs" align="center">
            <Text variant="caption" tone="muted">
              {`${account.name} · ${currencyInfo(currency).code}`}
            </Text>
            <HStack gap="sm">
              {step === 'category' ? (
                <IconButton
                  icon="chevron-left"
                  onPress={() => setStep('amount')}
                  accessibilityLabel="Back to amount"
                  size="sm"
                />
              ) : null}
              <Text
                variant="amountHero"
                numeric
                tone={direction === 'income' ? 'income' : 'default'}
                testID="cash-amount"
                adjustsFontSizeToFit
                numberOfLines={1}
              >
                {`${direction === 'income' ? '+' : ''}${padDisplay(value, currency)}`}
              </Text>
            </HStack>
          </VStack>

          {step === 'amount' ? (
            <>
              <SegmentedControl
                accessibilityLabel="Money out or in"
                value={direction}
                onChange={setDirection}
                options={[
                  { value: 'expense', label: 'Spent' },
                  { value: 'income', label: 'Received' },
                ]}
              />
              <NumberPad onKey={press} />
              <Button
                label="Choose category"
                onPress={() => setStep('category')}
                disabled={amount <= 0}
                fullWidth
                size="lg"
                testID="cash-next"
              />
            </>
          ) : (
            <View style={styles.grid}>
              {categories.map((c) => (
                <PressableScale
                  key={c.id}
                  onPress={() => pick(c)}
                  pressHaptic="selection"
                  accessibilityLabel={c.name}
                  testID={`cash-category-${c.id}`}
                  containerStyle={styles.tile}
                >
                  <View style={styles.categoryTile}>
                    <IconBadge icon={c.icon} color={c.color} />
                    <Text variant="caption" align="center" numberOfLines={2}>
                      {c.name}
                    </Text>
                  </View>
                </PressableScale>
              ))}
            </View>
          )}
        </VStack>
      )}
    </BottomSheet>
  );
}

function NumberPad({ onKey }: { onKey: (key: PadKey) => void }) {
  return (
    <View style={styles.pad} accessibilityLabel="Number pad">
      {PAD_KEYS.map((row, r) => (
        <View key={r} style={styles.padRow}>
          {row.map((key) => (
            <PressableScale
              key={key}
              onPress={() => onKey(key)}
              pressHaptic="selection"
              accessibilityLabel={key === 'back' ? 'Delete' : key === '.' ? 'Decimal point' : key}
              testID={`pad-${key}`}
              containerStyle={styles.cell}
            >
              <View style={styles.padKey}>
                {key === 'back' ? (
                  <Icon name="x" size="md" tone="muted" />
                ) : (
                  <Text variant="amountLarge" numeric>
                    {key}
                  </Text>
                )}
              </View>
            </PressableScale>
          ))}
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme, rt) => ({
  fabWrap: {
    position: 'absolute',
    right: theme.space.lg,
    bottom: { xs: theme.space.lg, md: theme.space.xl },
    paddingBottom: rt.insets.bottom,
  },
  fab: {
    width: theme.size.buttonLg,
    height: theme.size.buttonLg,
    borderRadius: theme.radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.accent,
    boxShadow: `0px ${theme.layout.shadowOffsetY}px ${theme.layout.shadowRadius}px ${theme.colors.overlay}`,
  },
  pad: { gap: theme.space.sm },
  padRow: { flexDirection: 'row', gap: theme.space.sm },
  cell: { flex: 1 },
  tile: { flexBasis: '30%', flexGrow: 1 },
  padKey: {
    height: theme.size.buttonLg,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surfaceSunken,
  },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.space.sm },
  categoryTile: {
    minHeight: theme.size.rowHeight + theme.size.avatarMd,
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.space.xs,
    padding: theme.space.sm,
    borderRadius: theme.radius.lg,
    backgroundColor: theme.colors.surfaceSunken,
  },
}));
