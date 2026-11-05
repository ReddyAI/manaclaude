import { useShareIntent, type ShareIntentFile } from 'expo-share-intent';
import { useMemo, useState } from 'react';
import { Image } from 'react-native';
import { formatShortDate, type Transaction } from '@manaclaude/shared';
import { StyleSheet } from 'react-native-unistyles';
import { BottomSheet } from '../../design/components/BottomSheet';
import { Button } from '../../design/components/Button';
import { TextField } from '../../design/components/Controls';
import { EmptyState } from '../../design/components/Decor';
import { VStack } from '../../design/components/Layout';
import { ListRow } from '../../design/components/ListRow';
import { MoneyText } from '../../design/components/MoneyText';
import { Text } from '../../design/components/Text';
import { haptic } from '../../design/haptics';
import { useFinance } from '../../data/store';
import { attachReceipt, saveUnmatchedReceipt } from './actions';
import { saveReceiptImage } from './receiptFiles';

/** Purchases that could own a shared receipt: spending without a receipt yet, newest first. */
export function receiptTargets(
  transactions: readonly Transaction[],
  query: string,
  limit = 25,
): Transaction[] {
  const q = query.trim().toLowerCase();
  return transactions
    .filter(
      (t) =>
        t.amount < 0 &&
        !t.receiptId &&
        !t.isSplitParent &&
        !t.splitParentId &&
        !t.transferLinkId &&
        (!q || t.name.toLowerCase().includes(q)),
    )
    .slice(0, limit);
}

/**
 * Android share sheet: share a photo from the gallery or camera app to Mana
 * and this sheet asks which purchase it belongs to. Mounted once in the root
 * layout. The share plugin is switched on for Android only (see app.json).
 */
export function ReceiptShareHandler() {
  const { hasShareIntent, shareIntent, resetShareIntent } = useShareIntent();
  const images: ShareIntentFile[] = (shareIntent.files ?? []).filter((f) =>
    f.mimeType?.startsWith('image/'),
  );
  const image = images[0];
  if (!hasShareIntent || !image) return null;
  return <SharedReceiptSheet image={image} onDone={() => resetShareIntent()} />;
}

export function SharedReceiptSheet({
  image,
  onDone,
}: {
  image: Pick<ShareIntentFile, 'path'>;
  onDone: () => void;
}) {
  const data = useFinance();
  const [query, setQuery] = useState('');
  const targets = useMemo(
    () => receiptTargets(data.transactions, query),
    [data.transactions, query],
  );

  const attachTo = (txn: Transaction) => {
    attachReceipt(txn.id, saveReceiptImage(image.path));
    haptic('confirm');
    onDone();
  };

  return (
    <BottomSheet visible onClose={onDone} title="Attach receipt" scrollable testID="share-sheet">
      <VStack gap="md" align="center">
        <Image source={{ uri: image.path }} style={styles.preview} resizeMode="cover" />
        <Text variant="caption" tone="muted" align="center">
          Which purchase is this receipt for?
        </Text>
      </VStack>
      <TextField
        icon="search"
        placeholder="Search purchases"
        value={query}
        onChangeText={setQuery}
        accessibilityLabel="Search purchases"
      />
      {targets.length === 0 ? (
        <EmptyState
          icon="receipt"
          title="No purchase found"
          message="Keep the photo and match it later."
        />
      ) : (
        targets.map((t) => (
          <ListRow
            key={t.id}
            title={t.name}
            subtitle={`${data.accounts.find((a) => a.id === t.accountId)?.name ?? ''} · ${formatShortDate(t.date)}`}
            trailing={<MoneyText amount={t.amount} currency={t.currency} />}
            onPress={() => attachTo(t)}
            testID={`share-target-${t.id}`}
          />
        ))
      )}
      <Button
        label="Keep without matching"
        variant="secondary"
        onPress={() => {
          saveUnmatchedReceipt(saveReceiptImage(image.path));
          haptic('confirm');
          onDone();
        }}
        fullWidth
      />
    </BottomSheet>
  );
}

const styles = StyleSheet.create((theme) => ({
  preview: {
    width: theme.size.avatarLg * 3,
    height: theme.size.avatarLg * 3,
    borderRadius: theme.radius.md,
  },
}));
