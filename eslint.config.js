// ESLint flat config for the whole monorepo.
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');
const prettierConfig = require('eslint-config-prettier');

const SIZE_KEYS =
  '^(fontSize|lineHeight|letterSpacing|borderRadius|borderWidth|padding|paddingTop|paddingBottom|paddingLeft|paddingRight|paddingHorizontal|paddingVertical|margin|marginTop|marginBottom|marginLeft|marginRight|marginHorizontal|marginVertical|gap|rowGap|columnGap|width|height|minWidth|minHeight|maxWidth|maxHeight|top|left|right|bottom)$';

module.exports = defineConfig([
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      '**/.expo/**',
      '**/.wrangler/**',
      'research/**',
      'apps/mobile/android/**',
      'apps/mobile/ios/**',
      'apps/mobile/expo-env.d.ts',
    ],
  },
  ...expoConfig,
  {
    rules: { 'no-console': ['warn', { allow: ['warn', 'error'] }] },
  },
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Screens never hard-code colours or sizes: everything comes from the theme.
    files: ['apps/mobile/src/features/**/*.{ts,tsx}', 'apps/mobile/src/app/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/^#([0-9a-fA-F]{3,8})$/]',
          message: 'Use a theme colour (theme.colors.*) instead of a hex literal.',
        },
        {
          selector: 'Literal[value=/^(rgb|rgba|hsl|hsla)\\(/]',
          message: 'Use a theme colour (theme.colors.*) instead of a colour literal.',
        },
        {
          selector: `Property[key.name=/${SIZE_KEYS}/][value.type='Literal'][value.value>0]`,
          message:
            'Use theme tokens (theme.space, theme.size, theme.radius, theme.type) instead of a number.',
        },
      ],
    },
  },
  {
    // Worker code: cloudflare:* modules exist only inside workerd, and the MCP
    // SDK publishes its entry points through a wildcard exports map.
    files: ['backend/**/*.{ts,mjs}'],
    rules: {
      'import/no-unresolved': [
        'error',
        { ignore: ['^cloudflare:', '^@modelcontextprotocol/sdk/'] },
      ],
    },
  },
  {
    files: ['**/*.test.{ts,tsx}', '**/__tests__/**/*.{ts,tsx}', 'apps/mobile/jest.setup.ts'],
    languageOptions: { globals: { jest: 'readonly' } },
    // jest.mock factories have to use require().
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    // Node-side config files.
    files: ['**/*.config.{js,ts}', 'eslint.config.js', 'apps/mobile/babel.config.js'],
    languageOptions: {
      globals: { module: 'writable', require: 'readonly', __dirname: 'readonly' },
    },
  },
  prettierConfig,
]);
