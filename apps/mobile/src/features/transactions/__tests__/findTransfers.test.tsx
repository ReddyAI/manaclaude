import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { createSampleData } from '@manaclaude/shared/sample';
import { setBackendConfigForTests } from '../../../data/backend/config';
import { held, json, settle } from '../../../data/backend/__tests__/helpers';
import { resetBackendForTests } from '../../../data/backend/sync';
import { setFinance } from '../../../data/store';
import { goTo } from '../../planning/navigate';
import { matchRunText } from '../FindTransfersCard';
import { PossibleTransfersScreen } from '../PossibleTransfersScreen';
import { TransactionsScreen } from '../TransactionsScreen';
import { goLive } from './live';

jest.mock('expo-router', () => ({
  router: { push: jest.fn(), navigate: jest.fn(), replace: jest.fn(), back: jest.fn() },
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
  Paths: { document: '/doc' },
}));
jest.mock('../../planning/navigate', () => ({ goTo: jest.fn(), goBack: jest.fn() }));
jest.mock('../../../design/haptics', () => ({
  ...jest.requireActual('../../../design/haptics'),
  haptic: jest.fn(),
}));

/** Block S: run the Worker's transfer matcher on demand. All data is invented. */

const press = (id: string) => fireEvent.press(screen.getByTestId(id));
let backend: Awaited<ReturnType<typeof goLive>> | undefined;
afterEach(() => {
  backend?.restore();
  backend = undefined;
  resetBackendForTests();
  setBackendConfigForTests({ url: '', token: '' });
});

describe('what a run did', () => {
  it('in plain words', () => {
    expect(matchRunText({ linked: 0, suggested: 0 })).toBe('No new transfers found.');
    expect(matchRunText({ linked: 1, suggested: 0 })).toBe(
      'Linked 1 transfer; they are out of spending and income now.',
    );
    expect(matchRunText({ linked: 2, suggested: 1 })).toBe(
      'Linked 2 transfers; they are out of spending and income now. 1 possible pair needs you to pick.',
    );
    expect(matchRunText({ linked: 0, suggested: 3 })).toBe('3 possible pairs need you to pick.');
  });
});

describe('Look for transfers now', () => {
  it('runs the matcher once, loads the data again and says what it did', async () => {
    backend = await goLive(createSampleData(), {
      'POST /v1/transfer-links/run': () => json(200, { linked: 1, suggested: 2 }),
    });
    await render(<PossibleTransfersScreen />);
    const loadsBefore = backend.sent('GET /v1/dataset').length;
    await press('find-transfers');
    await waitFor(() => expect(screen.getByTestId('find-transfers-result')).toBeTruthy());
    expect(backend.sent('POST /v1/transfer-links/run')).toHaveLength(1);
    expect(backend.sent('GET /v1/dataset').length).toBe(loadsBefore + 1);
    expect(screen.getByTestId('find-transfers-result').props.children).toBe(
      'Linked 1 transfer; they are out of spending and income now. 2 possible pairs need you to pick.',
    );
  });

  it('says what went wrong', async () => {
    backend = await goLive(createSampleData(), {
      'POST /v1/transfer-links/run': () => json(500, { error: 'internal', message: 'D1 failed.' }),
    });
    await render(<PossibleTransfersScreen />);
    await press('find-transfers');
    await waitFor(() =>
      expect(screen.getByTestId('find-transfers-result').props.children).toBe('D1 failed.'),
    );
  });

  it('one run for a fast double tap', async () => {
    const slow = held();
    backend = await goLive(createSampleData(), {
      'POST /v1/transfer-links/run': () => slow.promise,
    });
    await render(<PossibleTransfersScreen />);
    await act(async () => {
      fireEvent.press(screen.getByTestId('find-transfers'));
      fireEvent.press(screen.getByTestId('find-transfers'));
      await settle();
    });
    expect(backend.sent('POST /v1/transfer-links/run')).toHaveLength(1);
    await act(async () => {
      slow.release(200, { linked: 0, suggested: 0 });
      await settle();
    });
    expect(screen.getByTestId('find-transfers-result').props.children).toBe(
      'No new transfers found.',
    );
  });

  it('needs the Worker: not offered on sample data', async () => {
    resetBackendForTests();
    await act(() => setFinance(createSampleData()));
    await render(<PossibleTransfersScreen />);
    expect(screen.queryByTestId('find-transfers')).toBeNull();
    expect(screen.getByTestId('find-transfers-offline')).toBeTruthy();
  });

  it('Transactions offers the screen when nothing is suggested, only with the Worker', async () => {
    resetBackendForTests();
    await act(() => setFinance(createSampleData()));
    const sample = await render(<TransactionsScreen />);
    expect(screen.queryByTestId('open-find-transfers')).toBeNull();
    await sample.unmount();
    backend = await goLive(createSampleData());
    await render(<TransactionsScreen />);
    await press('open-find-transfers');
    expect(goTo).toHaveBeenCalledWith('/transactions/transfers');
  });
});
