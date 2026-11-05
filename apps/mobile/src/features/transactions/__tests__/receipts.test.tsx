import { fireEvent, render, screen } from '@testing-library/react-native';
import { useLookups } from '../../../data/selectors';
import { getFinance } from '../../../data/store';
import { attachReceipt, removeReceipt, saveUnmatchedReceipt } from '../actions';
import { receiptTargets } from '../ReceiptShareHandler';
import { pickReceiptImage } from '../receiptFiles';
import { TransactionDetailSheet } from '../TransactionDetailSheet';
import { resetFinance, txnById } from './helpers';

jest.mock('../../../design/haptics', () => ({
  ...jest.requireActual('../../../design/haptics'),
  haptic: jest.fn(),
}));
jest.mock('../receiptFiles', () => ({
  ...jest.requireActual('../receiptFiles'),
  pickReceiptImage: jest.fn(),
}));

function Detail({ id }: { id: string }) {
  const lookups = useLookups();
  return (
    <TransactionDetailSheet
      txn={lookups.transactionsById.get(id) ?? null}
      lookups={lookups}
      onClose={() => {}}
    />
  );
}

describe('receipts', () => {
  beforeEach(() => {
    resetFinance();
    (pickReceiptImage as jest.Mock).mockReset();
  });

  it('attaching a photo keeps it on the device with a placeholder R2 key', () => {
    const target = getFinance().transactions.find((t) => t.amount < 0 && !t.receiptId)!;
    const id = attachReceipt(target.id, 'file:///receipts/one.jpg');
    const receipt = getFinance().receipts.find((r) => r.id === id)!;
    expect(receipt).toMatchObject({
      localUri: 'file:///receipts/one.jpg',
      r2Key: `pending-upload/${id}.jpg`,
      matchedTransactionId: target.id,
      status: 'matched',
      lineItems: [],
    });
    expect(txnById(getFinance(), target.id).receiptId).toBe(id);
  });

  it('removing a receipt detaches it', () => {
    const target = getFinance().transactions.find((t) => t.amount < 0 && !t.receiptId)!;
    const id = attachReceipt(target.id, 'file:///receipts/one.jpg');
    removeReceipt(id);
    expect(getFinance().receipts.some((r) => r.id === id)).toBe(false);
    expect(txnById(getFinance(), target.id).receiptId).toBeNull();
  });

  it('a shared photo can be kept without a transaction', () => {
    const id = saveUnmatchedReceipt('file:///shared/a.jpg');
    const receipt = getFinance().receipts.find((r) => r.id === id)!;
    expect(receipt.matchedTransactionId).toBeNull();
    expect(receipt.status).toBe('uploaded');
  });

  it('offers recent purchases without a receipt for a shared photo', () => {
    const { transactions } = getFinance();
    const targets = receiptTargets(transactions, '');
    expect(targets.length).toBeGreaterThan(0);
    expect(
      targets.every((t) => t.amount < 0 && !t.receiptId && !t.transferLinkId && !t.splitParentId),
    ).toBe(true);
    const starbucks = receiptTargets(transactions, 'starbucks');
    expect(starbucks.every((t) => t.name.toLowerCase().includes('starbucks'))).toBe(true);
  });

  it('shows the photo choices, then the thumbnail after a gallery pick', async () => {
    const target = getFinance().transactions.find((t) => t.amount < 0 && !t.receiptId)!;
    (pickReceiptImage as jest.Mock).mockResolvedValue({
      status: 'picked',
      uri: 'file:///receipts/picked.jpg',
    });
    await render(<Detail id={target.id} />);
    expect(screen.getByTestId('receipt-empty')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('receipt-gallery'));
    expect(pickReceiptImage).toHaveBeenCalledWith('gallery');
    expect(await screen.findByTestId('receipt-thumbnail')).toBeTruthy();
    expect(screen.getByLabelText('Receipt photo')).toBeTruthy();
    expect(screen.getByText('Matched')).toBeTruthy();
  });

  it('shows a denied camera permission instead of failing quietly', async () => {
    const target = getFinance().transactions.find((t) => t.amount < 0 && !t.receiptId)!;
    (pickReceiptImage as jest.Mock).mockResolvedValue({
      status: 'denied',
      message: 'Camera access is off.',
    });
    const count = getFinance().receipts.length;
    await render(<Detail id={target.id} />);
    await fireEvent.press(screen.getByTestId('receipt-camera'));
    expect(await screen.findByText('Camera access is off.')).toBeTruthy();
    expect(getFinance().receipts).toHaveLength(count);
  });

  it('shows line items and the split action for a receipt that was read', async () => {
    await render(<Detail id="txn_tandoori" />);
    expect(screen.getByTestId('receipt-section')).toBeTruthy();
    expect(screen.getByText('Chicken tikka masala')).toBeTruthy();
    expect(screen.getByText('Tip')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('split-by-items'));
    expect(await screen.findByTestId('split-sheet')).toBeTruthy();
  });
});
