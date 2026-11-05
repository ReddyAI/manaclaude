import { CONNECTOR_REGISTRY, withSlotUsage } from '@manaclaude/connectors/registry';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { router } from 'expo-router';
import { setBackendConfigForTests } from '../../../data/backend/config';
import { getFinance } from '../../../data/store';
import { AccountsScreen } from '../AccountsScreen';
import { groupConnectors, slotsText, summarizeConnector } from '../health';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), navigate: jest.fn(), back: jest.fn(), canGoBack: () => true },
  useLocalSearchParams: () => ({}),
}));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));
jest.mock('expo-web-browser', () => ({ openAuthSessionAsync: jest.fn() }));
jest.mock('../../../design/haptics', () => ({
  ...jest.requireActual('../../../design/haptics'),
  haptic: jest.fn(),
}));

describe('connectors on the Accounts screen', () => {
  const data = () => getFinance();
  const registry = () => withSlotUsage(data().connectorSlotsUsed, CONNECTOR_REGISTRY);

  it('lists every connector in the registry exactly once', () => {
    const groups = groupConnectors(registry(), data().connections);
    const ids = groups.flatMap(([, list]) => list.map((s) => s.connector.id));
    expect(ids.sort()).toEqual(CONNECTOR_REGISTRY.map((c) => c.id).sort());
  });

  it('greys out unavailable connectors with their reason and sorts them last', () => {
    const groups = groupConnectors(registry(), data().connections);
    const all = groups.flatMap(([, list]) => list);
    const unavailable = all.filter((s) => s.connector.availability === 'unavailable');
    expect(unavailable.length).toBeGreaterThan(0);
    for (const s of unavailable) {
      expect(s.unavailableReason).toBeTruthy();
      expect(s.badge.label).toBe('Unavailable');
    }
    for (const [, list] of groups) {
      const order = list.map((s) => s.connector.availability);
      expect(order).toEqual([...order].sort((a, b) => rank(a) - rank(b)));
    }
  });

  it('shows free slots left for capped connectors', () => {
    const plaid = registry().find((c) => c.id === 'plaid')!;
    const left = plaid.freeSlotsTotal! - plaid.freeSlotsUsed;
    expect(slotsText(plaid)).toBe(`${left} of ${plaid.freeSlotsTotal} logins left`);
    expect(slotsText(registry().find((c) => c.id === 'sophtron')!)).toBe('No slot limit');
  });

  it('reports the worst status among a connector’s logins and the latest sync', () => {
    const connections = data().connections;
    const plaid = registry().find((c) => c.id === 'plaid')!;
    const summary = summarizeConnector(plaid, connections);
    expect(summary.connections.length).toBe(
      connections.filter((c) => c.connectorId === 'plaid').length,
    );
    const broken = connections.map((c) =>
      c.connectorId === 'plaid' ? { ...c, status: 'needs_repair' as const } : c,
    );
    expect(summarizeConnector(plaid, broken).badge.label).toBe('Repair');
  });

  it('renders the Connectors tab with status badges and a greyed unavailable row', async () => {
    await render(<AccountsScreen />);
    await fireEvent.press(screen.getByLabelText('Connectors'));
    expect(screen.getByTestId('connector-teller')).toBeTruthy();
    expect(screen.getByText('Teller shut down its API in July 2026')).toBeTruthy();
    expect(screen.getByTestId('connector-mercury')).toBeTruthy();
    expect(screen.getAllByText('Unavailable').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/ logins left/).length).toBeGreaterThan(0);
  });

  it('opens an account from the Accounts tab', async () => {
    const { router } = require('expo-router');
    await render(<AccountsScreen />);
    await fireEvent.press(screen.getByTestId('account-acc_checking'));
    expect(router.push).toHaveBeenCalledWith({
      pathname: '/accounts/[id]',
      params: { id: 'acc_checking' },
    });
  });
});

function rank(a: string): number {
  return a === 'available' ? 0 : a === 'paid' ? 1 : 2;
}

describe('adding and repairing accounts', () => {
  afterEach(() => setBackendConfigForTests({ url: '', token: '' }));

  it('Add account opens the link screen', async () => {
    await render(<AccountsScreen />);
    await fireEvent.press(screen.getByTestId('add-account'));
    expect(router.push).toHaveBeenCalledWith('/link');
  });

  it('Repair opens the repair flow for the same connection (planRepair)', async () => {
    setBackendConfigForTests({ url: 'https://api.demo.test', token: 'demo-token' });
    await render(<AccountsScreen />);
    const broken = getFinance().connections.find((c) => c.status === 'needs_repair')!;
    await fireEvent.press(screen.getByTestId(`repair-banner-${broken.id}`));
    expect(router.push).toHaveBeenCalledWith({
      pathname: '/link/[connector]',
      params: { connector: broken.connectorId, connectionId: broken.id },
    });
  });
});
