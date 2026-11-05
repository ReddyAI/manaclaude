import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { reportTreatment, type FinanceDataset, type TransferLink } from '@manaclaude/shared';
import { buildLookups, useLookups } from '../../../data/selectors';
import { getFinance, setFinance } from '../../../data/store';
import { confirmTransfer, linkTransfer, unlinkTransfer } from '../actions';
import { TransactionDetailSheet } from '../TransactionDetailSheet';
import { applyLinkTransfer, checkLink, inferLinkKind, transferCandidates } from '../transfers';
import { resetFinance, txnById } from './helpers';

jest.mock('../../../design/haptics', () => ({
  ...jest.requireActual('../../../design/haptics'),
  haptic: jest.fn(),
}));

function linkOf(data: FinanceDataset, pick: (l: TransferLink) => boolean): TransferLink {
  const link = data.transferLinks.find((l) => l.status === 'auto' && pick(l));
  if (!link) throw new Error('sample has no such link');
  return link;
}

function treatment(data: FinanceDataset, id: string) {
  return reportTreatment(txnById(data, id), buildLookups(data).treatment);
}

describe('manual link and unlink', () => {
  beforeEach(() => {
    resetFinance();
  });

  it('unlink keeps the record as rejected and both sides count again', () => {
    const link = linkOf(
      getFinance(),
      (l) => l.kind === 'transfer' && l.outCurrency === l.inCurrency,
    );
    expect(treatment(getFinance(), link.outTransactionId).kind).toBe('excluded');

    unlinkTransfer(link.id);

    const after = getFinance();
    const stored = after.transferLinks.find((l) => l.id === link.id);
    expect(stored?.status).toBe('rejected');
    for (const id of [link.outTransactionId, link.inTransactionId]) {
      const t = txnById(after, id);
      expect(t.transferLinkId).toBeNull();
      expect(t.kind).toBe('regular');
      expect(t.reviewed).toBe(false);
      expect(t.userEditedFields).toContain('kind');
    }
    // Out is spending and in is income now; the review queue will ask for a category.
    expect(treatment(after, link.outTransactionId).kind).toBe('spending');
    expect(treatment(after, link.inTransactionId).kind).toBe('income');
    expect(txnById(after, link.outTransactionId).categoryId).toBeNull();
  });

  it('link joins two transactions into one excluded pair', () => {
    const link = linkOf(
      getFinance(),
      (l) => l.kind === 'transfer' && l.outCurrency === l.inCurrency,
    );
    unlinkTransfer(link.id);
    linkTransfer(link.inTransactionId, link.outTransactionId); // order does not matter

    const after = getFinance();
    const fresh = after.transferLinks.find(
      (l) => l.status === 'confirmed' && l.matchedBy === 'user',
    );
    expect(fresh).toBeDefined();
    expect(fresh?.outTransactionId).toBe(link.outTransactionId);
    expect(fresh?.inTransactionId).toBe(link.inTransactionId);
    expect(fresh?.kind).toBe('transfer');
    expect(fresh?.matchScore).toBeNull();
    expect(txnById(after, link.outTransactionId).transferLinkId).toBe(fresh?.id);
    expect(treatment(after, link.outTransactionId).kind).toBe('excluded');
    expect(treatment(after, link.inTransactionId).kind).toBe('excluded');
    // The earlier rejection is still stored.
    expect(after.transferLinks.filter((l) => l.status === 'rejected')).toHaveLength(1);
  });

  it('records the real rate on a cross-currency link', () => {
    const link = linkOf(getFinance(), (l) => l.outCurrency === 'USD' && l.inCurrency === 'INR');
    unlinkTransfer(link.id);
    linkTransfer(link.outTransactionId, link.inTransactionId);
    const fresh = getFinance().transferLinks.find((l) => l.status === 'confirmed');
    expect(fresh?.outAmount).toBe(link.outAmount);
    expect(fresh?.inAmount).toBe(link.inAmount);
    expect(fresh?.impliedRate).toBeCloseTo(link.impliedRate, 3);
    expect(fresh?.inCurrency).toBe('INR');
  });

  it('works out card payments, loans, brokerage and cash', () => {
    const accounts = new Map(getFinance().accounts.map((a) => [a.id, a]));
    const kindOf = (from: string, into: string) =>
      inferLinkKind(accounts.get(from), accounts.get(into));
    expect(kindOf('acc_checking', 'acc_card_cashback')).toBe('card_payment');
    expect(kindOf('acc_checking', 'acc_brokerage')).toBe('investment_contribution');
    expect(kindOf('acc_checking', 'acc_auto_loan')).toBe('loan_payment');
    expect(kindOf('acc_checking', 'acc_cash_usd')).toBe('atm_withdrawal');
    expect(kindOf('acc_checking', 'acc_savings')).toBe('transfer');
  });

  it('a manual card payment link takes the card_payment kind', () => {
    const link = linkOf(getFinance(), (l) => l.kind === 'card_payment');
    unlinkTransfer(link.id);
    linkTransfer(link.outTransactionId, link.inTransactionId);
    const fresh = getFinance().transferLinks.find((l) => l.status === 'confirmed');
    expect(fresh?.kind).toBe('card_payment');
    expect(txnById(getFinance(), link.outTransactionId).kind).toBe('card_payment');
  });

  it('refuses pairs that are not a transfer', () => {
    const data = getFinance();
    const link = linkOf(data, (l) => l.kind === 'transfer' && l.outCurrency === l.inCurrency);
    const out = txnById(data, link.outTransactionId);
    const spending = data.transactions.find(
      (t) => t.amount < 0 && t.accountId !== out.accountId && !t.transferLinkId && !t.isSplitParent,
    )!;
    // Same sign.
    expect(checkLink(data, out.id, spending.id).ok).toBe(false);
    // Same transaction.
    expect(checkLink(data, out.id, out.id).ok).toBe(false);
    // Already linked.
    expect(checkLink(data, link.outTransactionId, link.inTransactionId).ok).toBe(false);
    // Nothing changes when a link is refused.
    expect(applyLinkTransfer(data, out.id, spending.id, 'now')).toBe(data);
  });

  it('suggests the counterpart first', () => {
    const link = linkOf(
      getFinance(),
      (l) => l.kind === 'transfer' && l.outCurrency === l.inCurrency,
    );
    unlinkTransfer(link.id);
    const data = getFinance();
    const candidates = transferCandidates(data, txnById(data, link.outTransactionId));
    expect(candidates[0]?.txn.id).toBe(link.inTransactionId);
    expect(candidates[0]?.score).toBeGreaterThan(0.9);
  });

  it('confirming a suggested link makes it count as a transfer', () => {
    const data = getFinance();
    const link = linkOf(data, (l) => l.kind === 'transfer' && l.outCurrency === l.inCurrency);
    // What the matcher leaves behind when it finds several candidates: a suggestion, and two
    // transactions that still look like ordinary spending and income.
    setFinance({
      ...data,
      transferLinks: data.transferLinks.map((l) =>
        l.id === link.id ? { ...l, status: 'suggested', matchedBy: 'matcher' } : l,
      ),
      transactions: data.transactions.map((t) =>
        t.id === link.outTransactionId || t.id === link.inTransactionId
          ? { ...t, kind: 'regular', categoryId: null, categorySource: null }
          : t,
      ),
    });
    expect(treatment(getFinance(), link.outTransactionId).kind).toBe('spending');
    confirmTransfer(link.id);
    expect(getFinance().transferLinks.find((l) => l.id === link.id)?.status).toBe('confirmed');
    expect(treatment(getFinance(), link.outTransactionId).kind).toBe('excluded');
  });
});

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

describe('transfer controls on the detail sheet', () => {
  beforeEach(() => {
    resetFinance();
  });

  it('shows both sides of a linked transfer and unlinks it', async () => {
    const link = linkOf(
      getFinance(),
      (l) => l.kind === 'transfer' && l.outCurrency === l.inCurrency,
    );
    await render(<Detail id={link.outTransactionId} />);
    expect(screen.getByTestId(`transfer-side-${link.outTransactionId}`)).toBeTruthy();
    expect(screen.getByTestId(`transfer-side-${link.inTransactionId}`)).toBeTruthy();
    expect(screen.getByText('Everyday Checking to High-Yield Savings')).toBeTruthy();

    await fireEvent.press(screen.getByTestId('unlink-transfer'));
    expect(getFinance().transferLinks.find((l) => l.id === link.id)?.status).toBe('rejected');
    expect(await screen.findByTestId('link-transfer')).toBeTruthy();
  });

  it('links two transactions from the candidate list', async () => {
    const link = linkOf(
      getFinance(),
      (l) => l.kind === 'transfer' && l.outCurrency === l.inCurrency,
    );
    await act(() => unlinkTransfer(link.id));
    await render(<Detail id={link.outTransactionId} />);
    await fireEvent.press(screen.getByTestId('link-transfer'));
    await fireEvent.press(await screen.findByTestId(`link-candidate-${link.inTransactionId}`));
    const fresh = getFinance().transferLinks.find((l) => l.status === 'confirmed');
    expect(fresh?.inTransactionId).toBe(link.inTransactionId);
    expect(await screen.findByTestId('unlink-transfer')).toBeTruthy();
  });
});
