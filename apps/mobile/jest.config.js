/**
 * Jest for the app: jest-expo preset with the native modules mocked.
 *
 * The clock is fixed: `Date` always reads 5 November 2026, noon UTC (the same
 * moment the backend tests use), so sample data and "this month" never move
 * with the real calendar. Only `Date` is replaced; timers and promises run
 * for real. A test that needs another moment calls `jest.setSystemTime()`.
 */
module.exports = {
  preset: 'jest-expo',
  fakeTimers: {
    enableGlobally: true,
    now: Date.parse('2026-11-05T12:00:00.000Z'),
    doNotFake: [
      'hrtime',
      'nextTick',
      'performance',
      'queueMicrotask',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'requestIdleCallback',
      'cancelIdleCallback',
      'setImmediate',
      'clearImmediate',
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout',
    ],
  },
  setupFiles: ['./jest.setup.ts'],
  moduleNameMapper: { '^lucide-react-native/icons/(.*)$': '<rootDir>/test/iconMock.js' },
  testMatch: ['<rootDir>/src/**/__tests__/**/*.test.{ts,tsx}'],
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@shopify/flash-list|react-native-svg|lucide-react-native|react-native-unistyles|react-native-nitro-modules|react-native-reanimated|react-native-worklets|@manaclaude/.*))',
  ],
};
