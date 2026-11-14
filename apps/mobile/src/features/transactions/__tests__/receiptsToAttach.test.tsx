import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { FinanceDataset, Receipt } from '@manaclaude/shared';
import { createSampleData } from '@manaclaude/shared/sample';
import { setBackendConfigForTests } from '../../../data/backend/config';
import { json, settle } from '../../../data/backend/__tests__/helpers';
import { resetBackendForTests } from '../../../data/backend/sync';
import { getFinance, setFinance } from '../../../data/store';
import { ReceiptImage } from '../ReceiptImage';
import { receiptsToAttach } from '../receiptInbox';
import { ReceiptsToAttachScreen } from '../ReceiptsToAttachScreen';
import { TransactionsScreen } from '../TransactionsScreen';
import { goLive } from './live';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true },
}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));
jest.mock('expo-file-system', () => ({
  File: class {
    exists = false;
    create() {}
    write() {}
    delete() {}
    async text() {
      return '';
    }
  },
  Directory: class {},
  Paths: { document: '/doc' },
}));
jest.mock('expo-image-picker', () => ({}));
jest.mock('../../../design/haptics', () => ({
  ...jest.requireActual('../../../design/haptics'),
  haptic: jest.fn(),
}));

/** All data is invented. A receipt left behind by a deleted cash entry, and one never matched. */
function withWaiting(): FinanceDataset {
  const d = createSampleData();
  const base = d.receipts[0]!;
  const waiting: Receipt[] = [
    {
      ...base,
      id: 'rcp_left',
      r2Key: 'receipts/rcp_left.jpg',
      merchant: 'Corner Shop',
      total: 12_40,
      currency: 'USD',
      date: d.transactions.find((t) => t.amount < 0 && !t.receiptId && !t.transferLinkId)!.date,
      matchedTransactionId: null,
      status: 'needs_review',
      localUri: null,
      createdAt: '2026-11-13T00:00:00.000Z',
    },
    {
      ...base,
      id: 'rcp_new',
      r2Key: 'receipts/rcp_new.jpg',
      merchant: 'Bakery',
      matchedTransactionId: null,
      status: 'parsed',
      localUri: null,
      createdAt: '2026-11-12T00:00:00.000Z',
    },
  ];
  return { ...d, receipts: [...d.receipts, ...waiting] };
}
const data = withWaiting();
const target = data.transactions.find(
  (t) => t.amount < 0 && !t.receiptId && !t.transferLinkId && !t.isSplitParent && !t.splitParentId,
)!;
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const image = () => new Response(PNG, { status: 200, headers: { 'content-type': 'image/png' } });

const press = (id: string) => fireEvent.press(screen.getByTestId(id));
let backend: Awaited<ReturnType<typeof goLive>> | undefined;
afterEach(() => {
  backend?.restore();
  backend = undefined;
  resetBackendForTests();
  setBackendConfigForTests({ url: '', token: '' });
  setFinance(createSampleData());
});

async function openReceipt(handlers: Parameters<typeof goLive>[1] = {}) {
  backend = await goLive(data, {
    'GET /v1/receipts/rcp_left/image': () => image(),
    ...handlers,
  });
  await render(<ReceiptsToAttachScreen />);
  await press('receipt-to-attach-rcp_left');
  await settle();
}

describe('receipts to attach', () => {
  it('lists the waiting receipts, newest first', async () => {
    backend = await goLive(data);
    await render(<ReceiptsToAttachScreen />);
    expect(screen.getByTestId('receipt-to-attach-rcp_left')).toBeTruthy();
    expect(screen.getByTestId('receipt-to-attach-rcp_new')).toBeTruthy();
    for (const r of createSampleData().receipts.filter((x) => x.status === 'matched'))
      expect(screen.queryByTestId(`receipt-to-attach-${r.id}`)).toBeNull();
  });

  it('is reached from a chip on Transactions, shown only when some are waiting', async () => {
    backend = await goLive(data);
    await render(<TransactionsScreen />);
    expect(screen.getByText(`Receipts to attach · ${receiptsToAttach(data).length}`)).toBeTruthy();
    screen.unmount();
    backend.restore();
    const none = createSampleData();
    backend = await goLive({
      ...none,
      receipts: none.receipts.filter((r) => r.status === 'matched'),
    });
    await render(<TransactionsScreen />);
    expect(screen.queryByTestId('open-receipts-to-attach')).toBeNull();
  });

  it('shows the photo from the Worker, asked not to be cached, held only in memory', async () => {
    await openReceipt();
    const calls = backend!.sent('GET /v1/receipts/rcp_left/image');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cache).toBe('no-store');
    expect(screen.getByTestId('attach-receipt-image').props.source).toEqual({
      uri: `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`,
    });
    // Nothing about the picture went into the app's data.
    expect(getFinance().receipts.find((r) => r.id === 'rcp_left')!.localUri).toBeNull();
  });

  it('says so when the photo cannot be loaded, and can try again', async () => {
    let tries = 0;
    await openReceipt({
      'GET /v1/receipts/rcp_left/image': () => {
        tries += 1;
        return tries === 1 ? json(404, { error: 'not_found', message: 'Image missing.' }) : image();
      },
    });
    expect(screen.getByTestId('attach-receipt-image-error')).toBeTruthy();
    await fireEvent.press(screen.getByText('Try again'));
    await settle();
    expect(screen.getByTestId('attach-receipt-image')).toBeTruthy();
  });

  it('attaches to the picked transaction after asking, and puts the Worker’s answer in the data', async () => {
    await openReceipt({
      'POST /v1/receipts/rcp_left/attach': () =>
        json(200, {
          receipt: {
            ...data.receipts.find((r) => r.id === 'rcp_left')!,
            matchedTransactionId: target.id,
            status: 'matched',
          },
        }),
    });
    await press(`attach-candidate-${target.id}`);
    expect(screen.getByTestId('attach-ask')).toBeTruthy();
    expect(backend!.sent('POST /v1/receipts/rcp_left/attach')).toHaveLength(0);
    await press('attach-confirm');
    await settle();
    expect(backend!.sent('POST /v1/receipts/rcp_left/attach').map((c) => c.body)).toEqual([
      { transactionId: target.id },
    ]);
    expect(screen.getByTestId('attach-done').props.children).toBe(`Attached to "${target.name}".`);
    expect(getFinance().transactions.find((t) => t.id === target.id)!.receiptId).toBe('rcp_left');
    expect(getFinance().receipts.find((r) => r.id === 'rcp_left')!.status).toBe('matched');
  });

  it('on 409 account_changed says the transaction went away and reloads', async () => {
    await openReceipt({
      'POST /v1/receipts/rcp_left/attach': () =>
        json(409, { error: 'account_changed', message: 'Changed.' }),
    });
    const loads = backend!.sent('GET /v1/dataset').length;
    await press(`attach-candidate-${target.id}`);
    await press('attach-confirm');
    await settle();
    expect(screen.getByTestId('attach-refused').props.children).toMatch(/was deleted while/);
    expect(backend!.sent('GET /v1/dataset').length).toBe(loads + 1);
    expect(backend!.sent('POST /v1/receipts/rcp_left/attach')).toHaveLength(1);
  });

  it('after a lost answer reloads and checks, never sending again by itself', async () => {
    await openReceipt({
      'POST /v1/receipts/rcp_left/attach': () =>
        Promise.reject(new TypeError('Network request failed')),
    });
    await press(`attach-candidate-${target.id}`);
    await press('attach-confirm');
    await waitFor(() => expect(screen.getByTestId('attach-refused')).toBeTruthy());
    expect(screen.getByTestId('attach-refused').props.children).toMatch(/was not attached/);
    expect(backend!.sent('POST /v1/receipts/rcp_left/attach')).toHaveLength(1);
  });
});

describe('a receipt photo that is not on this device', () => {
  it('is not fetched for sample data', async () => {
    setFinance(data);
    await render(
      <ReceiptImage receipt={data.receipts.find((r) => r.id === 'rcp_left')!} testID="img" />,
    );
    expect(screen.getByTestId('img-none')).toBeTruthy();
  });
});
