const js = require('@eslint/js');
const tsPlugin = require('@typescript-eslint/eslint-plugin');
const tsParser = require('@typescript-eslint/parser');
const globals = require('globals');

module.exports = [
  js.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: './tsconfig.eslint.json',
        tsconfigRootDir: __dirname,
        sourceType: 'module',
      },
      globals: {
        ...globals.node,
        ...globals.jest,
        Bun: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      '@typescript-eslint/interface-name-prefix': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      'no-unused-vars': 'off',
      // TypeScript resolves namespaces such as NodeJS; ESLint has no runtime
      // binding for them and must not treat type-only names as globals.
      'no-undef': 'off',
    },
  },
  {
    files: ['src/playback/*.test.ts', 'test/playback.integration.ts'],
    languageOptions: {
      globals: { Bun: 'readonly' },
      parserOptions: { project: './test/tsconfig.playback.json' },
    },
  },
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', '*.js'],
  },
];
