import { useState } from 'react';
import { Image, View } from 'react-native';
import { formatShortDate, type Receipt, type Transaction } from '@manaclaude/shared';
import { StyleSheet } from 'react-native-unistyles';
import { BottomSheet } from '../../design/components/BottomSheet';
import { Button } from '../../design/components/Button';
import { Badge, type BadgeTone } from '../../design/components/Controls';
import { Icon } from '../../design/components/Icon';
import { HStack, VStack } from '../../design/components/Layout';
import { MoneyText } from '../../design/components/MoneyText';
import { PressableScale } from '../../design/components/PressableScale';
import { Text } from '../../design/components/Text';
import { haptic } from '../../design/haptics';
import { attachReceipt, removeReceipt } from './actions';
import { ReceiptImage } from './ReceiptImage';
import { isOnWorker } from './receiptInbox';
import { pickReceiptImage, receiptSourcesAvailable, type ReceiptSource } from './receiptFiles';
import { SplitByItemsSheet } from './SplitByItemsSheet';

const STATUS: Record<Receipt['status'], { label: string; tone: BadgeTone }> = {
  uploaded: { label: 'Saved on device', tone: 'neutral' },
  processing: { label: 'Reading', tone: 'accent' },
  parsed: { label: 'Read', tone: 'income' },
  matched: { label: 'Matched', tone: 'income' },
  needs_review: { label: 'Check details', tone: 'pending' },
  failed: { label: 'Could not read', tone: 'danger' },
};

/**
 * Receipt on the transaction detail: attach one (camera, gallery; the share
 * sheet is handled by ReceiptShareHandler), see the thumbnail and line items,
 * and split the transaction by items.
 */
export function ReceiptSection({
  txn,
  receipt,
}: {
  txn: Transaction;
  receipt: Receipt | undefined;
}) {
  const [message, setMessage] = useState<string | null>(null);
  const [viewing, setViewing] = useState(false);
  const [splitting, setSplitting] = useState(false);

  const attach = async (source: ReceiptSource) => {
    setMessage(null);
    const result = await pickReceiptImage(source);
    if (result.status === 'picked') {
      attachReceipt(txn.id, result.uri);
      haptic('confirm');
    } else if (result.status === 'denied') {
      haptic('reject');
      setMessage(result.message);
    }
  };

  if (!receipt) {
    return (
      <VStack gap="sm" testID="receipt-empty">
        <Text variant="label" tone="muted" uppercase>
          Receipt
        </Text>
        <HStack gap="sm">
          {receiptSourcesAvailable().map((source) => (
            <Button
              key={source}
              label={source === 'camera' ? 'Take photo' : 'Choose photo'}
              icon={source === 'camera' ? 'camera' : 'paperclip'}
              variant="secondary"
              size="sm"
              onPress={() => void attach(source)}
              testID={`receipt-${source}`}
            />
          ))}
        </HStack>
        <Text variant="caption" tone="faint">
          You can also share a photo to Billionaire from your gallery.
        </Text>
        {message ? (
          <Text variant="caption" tone="danger">
            {message}
          </Text>
        ) : null}
      </VStack>
    );
  }

  const currency = receipt.currency ?? txn.currency;
  const status = STATUS[receipt.status];
  const canSplit = !txn.isSplitParent;

  return (
    <VStack gap="sm" testID="receipt-section">
      <HStack justify="space-between">
        <Text variant="label" tone="muted" uppercase>
          Receipt
        </Text>
        <Badge label={status.label} tone={status.tone} />
      </HStack>
      <HStack gap="md" align="flex-start">
        <PressableScale
          onPress={() => setViewing(true)}
          accessibilityLabel="Open receipt photo"
          disabled={!receipt.localUri && !isOnWorker(receipt)}
          testID="receipt-thumbnail"
        >
          <View style={styles.thumb}>
            {receipt.localUri ? (
              <Image
                source={{ uri: receipt.localUri }}
                style={styles.image}
                resizeMode="cover"
                accessibilityLabel="Receipt photo"
              />
            ) : (
              <Icon name="receipt" size="lg" tone="faint" />
            )}
          </View>
        </PressableScale>
        <VStack gap="xxs" flex={1}>
          <Text variant="bodyStrong" numberOfLines={1}>
            {receipt.merchant ?? 'Receipt'}
          </Text>
          <Text variant="caption" tone="muted">
            {receipt.date ? formatShortDate(receipt.date) : 'Date not read yet'}
          </Text>
          {receipt.total !== null ? (
            <MoneyText amount={receipt.total} currency={currency} size="small" />
          ) : null}
          {!receipt.localUri ? (
            <Text variant="caption" tone="faint">
              {isOnWorker(receipt)
                ? 'The photo is not on this device. Tap it to load it from your Worker.'
                : 'The photo is not on this device.'}
            </Text>
          ) : null}
        </VStack>
      </HStack>

      {receipt.lineItems.length > 0 ? (
        <VStack gap="xs">
          {receipt.lineItems.map((li) => (
            <HStack key={li.id} justify="space-between">
              <Text variant="caption" style={styles.itemName} numberOfLines={1}>
                {li.quantity && li.quantity !== '1'
                  ? `${li.quantity} x ${li.description}`
                  : li.description}
              </Text>
              <MoneyText amount={li.amount} currency={currency} size="small" />
            </HStack>
          ))}
          {receipt.tax ? (
            <HStack justify="space-between">
              <Text variant="caption" tone="muted">
                Tax
              </Text>
              <MoneyText amount={receipt.tax} currency={currency} size="small" tone="muted" />
            </HStack>
          ) : null}
          {receipt.tip ? (
            <HStack justify="space-between">
              <Text variant="caption" tone="muted">
                Tip
              </Text>
              <MoneyText amount={receipt.tip} currency={currency} size="small" tone="muted" />
            </HStack>
          ) : null}
        </VStack>
      ) : (
        <Text variant="caption" tone="muted">
          No line items yet. They appear once the receipt is read, or add them by hand when you
          split.
        </Text>
      )}

      <HStack gap="sm" wrap>
        {canSplit ? (
          <Button
            label="Split by items"
            icon="split"
            variant="secondary"
            size="sm"
            onPress={() => setSplitting(true)}
            testID="split-by-items"
          />
        ) : null}
        <Button
          label="Remove receipt"
          variant="ghost"
          size="sm"
          onPress={() => {
            haptic('tap');
            removeReceipt(receipt.id);
          }}
          testID="remove-receipt"
        />
      </HStack>

      {canSplit ? (
        <SplitByItemsSheet
          txn={txn}
          receipt={receipt}
          visible={splitting}
          onClose={() => setSplitting(false)}
        />
      ) : null}
      <BottomSheet
        visible={viewing}
        onClose={() => setViewing(false)}
        title={receipt.merchant ?? 'Receipt'}
      >
        {viewing ? <ReceiptImage receipt={receipt} testID="receipt-full" /> : null}
      </BottomSheet>
    </VStack>
  );
}

const styles = StyleSheet.create((theme) => ({
  thumb: {
    width: theme.size.avatarLg * 2,
    height: theme.size.avatarLg * 2.5,
    borderRadius: theme.radius.md,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.surfaceSunken,
  },
  image: { width: '100%', height: '100%' },
  itemName: { flex: 1, marginRight: theme.space.md },
}));
