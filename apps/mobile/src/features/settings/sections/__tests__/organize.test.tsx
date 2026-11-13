import { fireEvent, render, screen } from '@testing-library/react-native';
import { setBackendConfigForTests } from '../../../../data/backend/config';
import { goTo } from '../../../planning/navigate';
import { AiSection } from '../AiSection';
import { OrganizeSection } from '../OrganizeSection';

jest.mock('../../../planning/navigate', () => ({ goTo: jest.fn() }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));

describe('Settings, categories and rules', () => {
  beforeEach(() => jest.clearAllMocks());

  it('opens the categories and rules screens', async () => {
    setBackendConfigForTests({ url: 'https://api.demo.test', token: 'demo-token' });
    await render(<OrganizeSection />);
    await fireEvent.press(screen.getByTestId('settings-categories'));
    await fireEvent.press(screen.getByTestId('settings-rules'));
    expect(goTo).toHaveBeenNthCalledWith(1, '/categories');
    expect(goTo).toHaveBeenNthCalledWith(2, '/rules');
  });

  it('says the backend is needed when none is set', async () => {
    setBackendConfigForTests({ url: '', token: '' });
    await render(<OrganizeSection />);
    expect(screen.getAllByText('Needs the backend (Settings, Backend)')).toHaveLength(2);
  });
});

describe('Settings, Ask AI', () => {
  beforeEach(() => jest.clearAllMocks());

  it('opens Ask AI when a backend is set, and is absent without one', async () => {
    setBackendConfigForTests({ url: 'https://api.demo.test', token: 'demo-token' });
    const view = await render(<AiSection />);
    await fireEvent.press(screen.getByTestId('settings-ask'));
    expect(goTo).toHaveBeenCalledWith('/ask');
    await view.unmount();
    setBackendConfigForTests({ url: '', token: '' });
    await render(<AiSection />);
    expect(screen.queryByTestId('settings-ask')).toBeNull();
  });
});
