/** Jest for the app: jest-expo preset with the native modules mocked. */
module.exports = {
  preset: 'jest-expo',
  setupFiles: ['./jest.setup.ts'],
  moduleNameMapper: { '^lucide-react-native/icons/(.*)$': '<rootDir>/test/iconMock.js' },
  testMatch: ['<rootDir>/src/**/__tests__/**/*.test.{ts,tsx}'],
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@shopify/flash-list|react-native-svg|lucide-react-native|react-native-unistyles|react-native-nitro-modules|react-native-reanimated|react-native-worklets|@manaclaude/.*))',
  ],
};
