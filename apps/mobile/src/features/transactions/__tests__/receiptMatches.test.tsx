import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { FinanceDataset, Receipt, ReceiptResponse, Transaction } from '@manaclaude/shared';
import { createSampleData } from '@manaclaude/shared/sample';
import { setBackendConfigForTests } from '../../../data/backend/config';
import { held, json, settle } from '../../../data/backend/__tests__/helpers';
import { resetBackendForTests } from '../../../data/backend/sync';
import { getFinance, setFinance } from '../../../data/store';
import { pickReceiptImage } from '../receiptFiles';
import { matchesView, noMatchText, reasonText } from '../receiptMatches';
import { ReceiptsToAttachScreen } from '../ReceiptsToAttachScreen';
import { SharedReceiptSheet } from '../ReceiptShareHandler';
import { goLive } from './live';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true },
}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));
jest.mock('expo-share-intent', () => ({ useShareIntent: jest.fn() }));
jest.mock('expo-image-picker', () => ({}));
jest.mock('../receiptFiles', () => ({
  ...jest.requireActual('../receiptFiles'),
  saveReceiptImage: (uri: string) => uri,
  pickReceiptImage: jest.fn(),
}));
jest.mock('../../../design/haptics', () => ({
  ...jest.requireActual('../../../design/haptics'),
  haptic: jest.fn(),
}));

// All data is invented.
const base = createSampleData();
const open = base.transactions.filter(
  (t) => t.amount < 0 && !t.receiptId && !t.transferLinkId && !t.isSplitParent && !t.splitParentId,
);
const first = open[0]!;
const second = open[1]!;
const third = open[2]!;
const PHOTO = 'file:///shared/receipt-demo.jpg';
const UPLOAD = 'POST /v1/receipts';
const DATASET = 'GET /v1/dataset';
const attachKey = (id: string) => `POST /v1/receipts/${id}/attach`;

function receipt(over: Partial<Receipt> = {}): Receipt {
  return {
    id: 'rcpt_demo1',
    r2Key: 'receipts/2026-11/rcpt_demo1',
    merchant: 'Demo Bakery',
    date: first.date,
    total: -first.amount,
    subtotal: null,
    tax: null,
    tip: null,
    currency: first.currency,
    lineItems: [],
    matchedTransactionId: null,
    status: 'needs_review',
    aiConfidence: 0.8,
    createdAt: '2026-11-05T11:00:00.000Z',
    updatedAt: '2026-11-05T11:00:00.000Z',
    ...over,
  };
}

const twoLikely = (): ReceiptResponse => ({
  receipt: receipt(),
  match: null,
  candidates: [
    { transactionId: second.id, score: 0.55, reason: 'same amount, 2 days apart' },
    { transactionId: first.id, score: 0.7, reason: 'same amount, same day, merchant matches' },
  ],
});

/** A stand-in Worker whose dataset follows the uploads and attaches it answers. */
let data: FinanceDataset;
function attachOnWorker(receiptId: string, txnId: string): Receipt {
  const r = data.receipts.find((x) => x.id === receiptId)!;
  const next = { ...r, matchedTransactionId: txnId, status: 'matched' as const };
  data = {
    ...data,
    receipts: data.receipts.map((x) => (x.id === receiptId ? next : x)),
    transactions: data.transactions.map((t) =>
      t.id === txnId
        ? { ...t, receiptId }
        : t.receiptId === receiptId
          ? { ...t, receiptId: null }
          : t,
    ),
  };
  return next;
}
function storeOnWorker(res: ReceiptResponse) {
  data = { ...data, receipts: [...data.receipts, res.receipt] };
  if (res.receipt.matchedTransactionId)
    attachOnWorker(res.receipt.id, res.receipt.matchedTransactionId);
}

let backend: Awaited<ReturnType<typeof goLive>> | undefined;
async function live(handlers: Parameters<typeof goLive>[1] = {}) {
  data = createSampleData();
  backend = await goLive(data, { [DATASET]: () => json(200, data), ...handlers });
}
const uploads = (res: ReceiptResponse) => () => {
  storeOnWorker(res);
  return json(201, res);
};
const attaching = (receiptId = 'rcpt_demo1') => ({
  [attachKey(receiptId)]: (call: { body: unknown }) =>
    json(200, {
      receipt: attachOnWorker(receiptId, (call.body as { transactionId: string }).transactionId),
    }),
});

afterEach(() => {
  backend?.restore();
  backend = undefined;
  resetBackendForTests();
  setBackendConfigForTests({ url: '', token: '' });
  setFinance(createSampleData());
});
beforeEach(() => jest.clearAllMocks());

const press = (id: string) => fireEvent.press(screen.getByTestId(id));
async function share() {
  await render(<SharedReceiptSheet image={{ path: PHOTO }} onDone={jest.fn()} />);
  await press('share-keep');
  await settle();
}

describe('what the Worker said about a receipt', () => {
  it('puts the best likely purchase first and the matched one apart', () => {
    const v = matchesView(twoLikely(), base.transactions);
    expect(v.matched).toBeNull();
    expect(v.likely.map((p) => p.txn?.id)).toEqual([first.id, second.id]);
    const m = matchesView(
      {
        match: { transactionId: first.id, score: 0.95, reason: 'same amount, same day' },
        candidates: [
          { transactionId: first.id, score: 0.95, reason: 'same amount, same day' },
          { transactionId: 'txn_not_here', score: 0.5, reason: 'amount plus a tip, 1 day apart' },
        ],
      },
      base.transactions,
    );
    expect(m.matched?.txn?.id).toBe(first.id);
    expect(m.likely.map((p) => p.match.transactionId)).toEqual(['txn_not_here']);
    expect(m.likely[0]!.txn).toBeNull();
  });

  it("writes the Worker's reason as a sentence and says why there are none", () => {
    expect(reasonText('same amount, 1 day apart')).toBe('Same amount, 1 day apart');
    expect(noMatchText(receipt({ status: 'failed', total: null }))).toMatch(/could not read this/);
    expect(noMatchText(receipt({ status: 'uploaded', total: null }))).toMatch(/AI is off/);
    expect(noMatchText(receipt({ status: 'parsed', total: null }))).toMatch(/total or the date/);
    expect(noMatchText(receipt({ status: 'parsed' }))).toMatch(/within 3 days/);
  });
});

describe('a shared receipt with no transaction', () => {
  it('is sent once and shows the likely purchases with the reason; one tap attaches', async () => {
    await live({ [UPLOAD]: uploads(twoLikely()), ...attaching() });
    await share();
    await waitFor(() => expect(screen.getByTestId(`receipt-likely-${first.id}`)).toBeTruthy());
    expect(backend!.sent(UPLOAD)).toHaveLength(1);
    expect(screen.getByTestId(`receipt-likely-reason-${first.id}`).props.children).toBe(
      'Same amount, same day, merchant matches',
    );
    expect(screen.getByTestId(`receipt-likely-reason-${second.id}`).props.children).toBe(
      'Same amount, 2 days apart',
    );
    await press(`receipt-likely-attach-${second.id}`);
    await waitFor(() => expect(screen.getByTestId('receipt-match-attached')).toBeTruthy());
    expect(screen.getByTestId('receipt-match-attached').props.children).toBe(
      `Attached to "${second.name}".`,
    );
    expect(backend!.sent(attachKey('rcpt_demo1'))).toHaveLength(1);
    expect(backend!.sent(attachKey('rcpt_demo1'))[0]!.body).toEqual({ transactionId: second.id });
    expect(getFinance().transactions.find((t) => t.id === second.id)!.receiptId).toBe('rcpt_demo1');
  });

  it('says which purchase the Worker attached it to, and offers the others', async () => {
    const res: ReceiptResponse = {
      receipt: receipt({ matchedTransactionId: first.id, status: 'matched' }),
      match: { transactionId: first.id, score: 0.95, reason: 'same amount, same day' },
      candidates: [
        { transactionId: third.id, score: 0.4, reason: 'amount plus a tip, 3 days apart' },
      ],
    };
    await live({ [UPLOAD]: uploads(res), ...attaching() });
    await share();
    await waitFor(() => expect(screen.getByTestId('receipt-auto-matched')).toBeTruthy());
    expect(screen.getByTestId('receipt-auto-matched').props.children).toMatch(
      new RegExp(`^Your Worker attached it to "${first.name}" on `),
    );
    expect(screen.getByText('Same amount, same day.')).toBeTruthy();
    expect(getFinance().transactions.find((t) => t.id === first.id)!.receiptId).toBe('rcpt_demo1');
    expect(screen.getByText('Not this one? Other likely purchases')).toBeTruthy();
    expect(screen.getByTestId(`receipt-likely-${third.id}`)).toBeTruthy();
    expect(screen.queryByTestId('receipt-upload-inbox')).toBeNull();
  });

  it("offers the matched purchase again when the Worker's data no longer has it there", async () => {
    const res: ReceiptResponse = {
      receipt: receipt({ matchedTransactionId: first.id, status: 'matched' }),
      match: { transactionId: first.id, score: 0.95, reason: 'same amount, same day' },
      candidates: [],
    };
    // Stored without the match, as if it had been undone before the data was read again.
    await live({
      [UPLOAD]: () => {
        storeOnWorker({ ...res, receipt: receipt() });
        return json(201, res);
      },
    });
    await share();
    await waitFor(() => expect(screen.getByTestId(`receipt-likely-${first.id}`)).toBeTruthy());
    expect(screen.queryByTestId('receipt-auto-matched')).toBeNull();
  });

  it('a fast double tap sends one upload', async () => {
    const answer = held();
    await live({ [UPLOAD]: () => answer.promise });
    await render(<SharedReceiptSheet image={{ path: PHOTO }} onDone={jest.fn()} />);
    await act(async () => {
      fireEvent.press(screen.getByTestId('share-keep'));
      fireEvent.press(screen.getByTestId('share-keep'));
    });
    await act(async () => answer.release(201, twoLikely()));
    await waitFor(() => expect(screen.getByTestId(`receipt-likely-${first.id}`)).toBeTruthy());
    expect(backend!.sent(UPLOAD)).toHaveLength(1);
  });

  it('one tap on Attach sends one attach', async () => {
    const answer = held();
    await live({ [UPLOAD]: uploads(twoLikely()), [attachKey('rcpt_demo1')]: () => answer.promise });
    await share();
    await waitFor(() => expect(screen.getByTestId(`receipt-likely-${first.id}`)).toBeTruthy());
    await act(async () => {
      fireEvent.press(screen.getByTestId(`receipt-likely-attach-${first.id}`));
      fireEvent.press(screen.getByTestId(`receipt-likely-attach-${second.id}`));
    });
    await act(async () => answer.release(200, { receipt: attachOnWorker('rcpt_demo1', first.id) }));
    await waitFor(() => expect(screen.getByTestId('receipt-match-attached')).toBeTruthy());
    expect(backend!.sent(attachKey('rcpt_demo1'))).toHaveLength(1);
  });

  it('says why there are none and where it waits', async () => {
    const res: ReceiptResponse = {
      receipt: receipt({ status: 'uploaded', total: null, date: null, merchant: null }),
      match: null,
      candidates: [],
    };
    await live({ [UPLOAD]: uploads(res) });
    await share();
    await waitFor(() => expect(screen.getByTestId('receipt-match-none')).toBeTruthy());
    expect(screen.getByTestId('receipt-match-none').props.children).toMatch(/AI is off/);
    expect(screen.getByTestId('receipt-upload-inbox')).toBeTruthy();
  });

  it('on 409 account_changed attaches nothing and loads the data again', async () => {
    await live({
      [UPLOAD]: uploads(twoLikely()),
      [attachKey('rcpt_demo1')]: () =>
        json(409, { error: 'account_changed', message: 'The transaction changed.' }),
    });
    await share();
    await waitFor(() => expect(screen.getByTestId(`receipt-likely-${first.id}`)).toBeTruthy());
    const loads = backend!.sent(DATASET).length;
    await press(`receipt-likely-attach-${first.id}`);
    await waitFor(() => expect(screen.getByTestId('receipt-match-refused')).toBeTruthy());
    expect(screen.getByTestId('receipt-match-refused').props.children).toMatch(
      /^That transaction was deleted while the receipt was being attached, so nothing was attached/,
    );
    await waitFor(() => expect(backend!.sent(DATASET).length).toBeGreaterThan(loads));
    expect(data.receipts.find((r) => r.id === 'rcpt_demo1')!.matchedTransactionId).toBeNull();
    expect(screen.queryByTestId('receipt-match-attached')).toBeNull();
  });

  it('after a lost attach answer checks the data and never sends again by itself', async () => {
    await live({
      [UPLOAD]: uploads(twoLikely()),
      [attachKey('rcpt_demo1')]: (call) => {
        attachOnWorker('rcpt_demo1', (call.body as { transactionId: string }).transactionId);
        return Promise.reject(new TypeError('Network request failed'));
      },
    });
    await share();
    await waitFor(() => expect(screen.getByTestId(`receipt-likely-${first.id}`)).toBeTruthy());
    await press(`receipt-likely-attach-${first.id}`);
    await waitFor(() => expect(screen.getByTestId('receipt-match-attached')).toBeTruthy());
    expect(backend!.sent(attachKey('rcpt_demo1'))).toHaveLength(1);
  });

  it('after a lost attach answer that did nothing, says so and lets you pick again', async () => {
    await live({
      [UPLOAD]: uploads(twoLikely()),
      [attachKey('rcpt_demo1')]: () => Promise.reject(new TypeError('Network request failed')),
    });
    await share();
    await waitFor(() => expect(screen.getByTestId(`receipt-likely-${first.id}`)).toBeTruthy());
    await press(`receipt-likely-attach-${first.id}`);
    await waitFor(() => expect(screen.getByTestId('receipt-match-refused')).toBeTruthy());
    expect(screen.getByTestId('receipt-match-refused').props.children).toMatch(
      /answer was lost and the receipt was not attached/,
    );
    await settle(20);
    expect(backend!.sent(attachKey('rcpt_demo1'))).toHaveLength(1);
  });

  it('after a lost upload answer finds the stored receipt and never sends again', async () => {
    await live({
      [UPLOAD]: () => {
        storeOnWorker(twoLikely());
        return Promise.reject(new TypeError('Network request failed'));
      },
    });
    await share();
    await waitFor(() => expect(screen.getByTestId('receipt-upload-unsure')).toBeTruthy());
    expect(screen.getByTestId('receipt-upload-unsure').props.children).toMatch(
      /stored the receipt, but its answer with the likely purchases was lost/,
    );
    expect(screen.getByTestId('receipt-upload-found').props.children).toMatch(
      /waiting in Receipts to attach/,
    );
    await settle(20);
    expect(backend!.sent(UPLOAD)).toHaveLength(1);
  });

  it('after a lost upload answer with nothing stored, says so and sends nothing again', async () => {
    await live({ [UPLOAD]: () => Promise.reject(new TypeError('Network request failed')) });
    await share();
    await waitFor(() => expect(screen.getByTestId('receipt-upload-unsure')).toBeTruthy());
    expect(screen.getByTestId('receipt-upload-unsure').props.children).toMatch(
      /not in your data yet. Nothing was sent again/,
    );
    await settle(20);
    expect(backend!.sent(UPLOAD)).toHaveLength(1);
  });

  it("passes on the Worker's reason when it refuses the photo", async () => {
    await live({
      [UPLOAD]: () =>
        json(400, { error: 'bad_request', message: 'Send a JPEG, PNG, WebP or GIF image.' }),
    });
    await share();
    await waitFor(() => expect(screen.getByTestId('receipt-upload-refused')).toBeTruthy());
    expect(screen.getByTestId('receipt-upload-refused').props.children).toBe(
      'The receipt was not stored. Send a JPEG, PNG, WebP or GIF image.',
    );
  });

  it('loads the data again when a likely purchase is not on the device yet', async () => {
    const extra: Transaction = { ...first, id: 'txn_arrived_later', name: 'Demo Cafe' };
    await live({
      [UPLOAD]: () => {
        storeOnWorker(twoLikely());
        data = { ...data, transactions: [...data.transactions, extra] };
        return json(201, {
          ...twoLikely(),
          candidates: [{ transactionId: extra.id, score: 0.6, reason: 'same amount, same day' }],
        });
      },
    });
    const loads = backend!.sent(DATASET).length;
    await share();
    await waitFor(() => expect(backend!.sent(DATASET).length).toBeGreaterThan(loads));
    await waitFor(() => expect(screen.getByText('Demo Cafe')).toBeTruthy());
  });

  it('with sample data keeps the photo on the device and sends nothing', async () => {
    resetBackendForTests();
    setFinance(createSampleData());
    await render(<SharedReceiptSheet image={{ path: PHOTO }} onDone={jest.fn()} />);
    expect(screen.getByText('Keep without matching')).toBeTruthy();
  });
});

describe('adding a receipt photo on Receipts to attach', () => {
  it('picks a photo, sends it and shows the likely purchases', async () => {
    (pickReceiptImage as jest.Mock).mockResolvedValue({ status: 'picked', uri: PHOTO });
    await live({ [UPLOAD]: uploads(twoLikely()), ...attaching() });
    await render(<ReceiptsToAttachScreen />);
    await press('receipt-add-gallery');
    await waitFor(() => expect(screen.getByTestId(`receipt-likely-${first.id}`)).toBeTruthy());
    expect(backend!.sent(UPLOAD)).toHaveLength(1);
    await press(`receipt-likely-attach-${first.id}`);
    await waitFor(() => expect(screen.getByTestId('receipt-match-attached')).toBeTruthy());
  });

  it('says so when the camera is not allowed', async () => {
    (pickReceiptImage as jest.Mock).mockResolvedValue({
      status: 'denied',
      message: 'Camera access is off. Allow it in Settings to photograph receipts.',
    });
    await live();
    await render(<ReceiptsToAttachScreen />);
    await press('receipt-add-gallery');
    await waitFor(() =>
      expect(
        screen.getByText('Camera access is off. Allow it in Settings to photograph receipts.'),
      ).toBeTruthy(),
    );
    expect(backend!.sent(UPLOAD)).toHaveLength(0);
  });
});
