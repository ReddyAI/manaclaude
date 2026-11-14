import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { setBackendConfigForTests } from '../../../../data/backend/config';
import { fakeBackend, json } from '../../../../data/backend/__tests__/helpers';
import { scheduleRefresh } from '../../../../data/backend/sync';
import { refreshText, usdInrStore } from '../../../currency/fxApi';
import { ExchangeRatesSection } from '../ExchangeRatesSection';

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));
jest.mock('../../../../data/backend/sync', () => ({ scheduleRefresh: jest.fn() }));
const reload = scheduleRefresh as jest.Mock;

const LATEST = 'GET /v1/fx/latest';
let rate = 88.12;
let backend: ReturnType<typeof fakeBackend>;
function worker(refresh: { openExchangeRates: number; frankfurter: number } | 'down') {
  rate = 88.12;
  backend = fakeBackend({
    [LATEST]: () =>
      json(200, {
        base: 'USD',
        quote: 'INR',
        rate,
        asOf: '2026-11-13T14:00:00.000Z',
        source: 'frankfurter_ecb',
      }),
    'POST /v1/fx/refresh': () => {
      if (refresh === 'down')
        return json(500, { error: 'internal', message: 'Something went wrong on the server.' });
      rate = 88.4;
      return json(200, refresh);
    },
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  usdInrStore.reset();
  setBackendConfigForTests({ url: 'https://api.demo.test', token: 'demo-token' });
});
afterEach(() => backend?.restore());

describe('exchange rates in Settings', () => {
  it('shows the rate the Worker has, when and by whom it was published', async () => {
    worker({ openExchangeRates: 0, frankfurter: 30 });
    await render(<ExchangeRatesSection />);
    await waitFor(() => expect(screen.getByText('1 USD = 88.1200 INR')).toBeTruthy());
    expect(backend.sent(LATEST)[0]!.path).toBe('/v1/fx/latest');
    expect(
      screen.getByText(
        'Published 2026-11-13 14:00 UTC by European Central Bank (through Frankfurter). The Worker fetches new rates every hour.',
      ),
    ).toBeTruthy();
  });

  it('refreshes now, says what came back, and loads the new rate and the data', async () => {
    worker({ openExchangeRates: 0, frankfurter: 30 });
    await render(<ExchangeRatesSection />);
    await waitFor(() => expect(screen.getByText('1 USD = 88.1200 INR')).toBeTruthy());
    await fireEvent.press(screen.getByTestId('fx-refresh'));
    await waitFor(() => expect(screen.getByText('1 USD = 88.4000 INR')).toBeTruthy());
    expect(backend.sent('POST /v1/fx/refresh')).toHaveLength(1);
    expect(screen.getByTestId('fx-refresh-result').props.children).toBe(
      'The European Central Bank gave 30 rates. Open Exchange Rates gave none: either its key is not set on the Worker or it could not be reached; the Worker does not say which.',
    );
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('says plainly when nothing came back, and loads nothing again', async () => {
    worker({ openExchangeRates: 0, frankfurter: 0 });
    await render(<ExchangeRatesSection />);
    await fireEvent.press(screen.getByTestId('fx-refresh'));
    await waitFor(() => expect(screen.getByTestId('fx-refresh-result')).toBeTruthy());
    expect(screen.getByTestId('fx-refresh-result').props.children).toMatch(
      /^No rates came back from either source/,
    );
    expect(reload).not.toHaveBeenCalled();
  });

  it('shows the Worker’s error', async () => {
    worker('down');
    await render(<ExchangeRatesSection />);
    await fireEvent.press(screen.getByTestId('fx-refresh'));
    await waitFor(() => expect(screen.getByTestId('fx-refresh-result')).toBeTruthy());
    expect(screen.getByText('Something went wrong on the server.')).toBeTruthy();
  });

  it('needs the backend, and sends nothing without one', async () => {
    worker({ openExchangeRates: 1, frankfurter: 1 });
    setBackendConfigForTests({ url: '', token: '' });
    await render(<ExchangeRatesSection />);
    expect(screen.getByText('Needs the backend')).toBeTruthy();
    expect(screen.queryByTestId('fx-refresh')).toBeNull();
    expect(backend.calls).toHaveLength(0);
  });

  it('words every combination of sources', () => {
    expect(refreshText({ openExchangeRates: 170, frankfurter: 30 })).toBe(
      'Open Exchange Rates gave 170 rates and the European Central Bank 30 rates.',
    );
    expect(refreshText({ openExchangeRates: 1, frankfurter: 0 })).toBe(
      'Open Exchange Rates gave 1 rate. The European Central Bank gave none: it could not be reached.',
    );
  });
});
