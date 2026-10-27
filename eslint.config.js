import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      'client/dist/**',
      'client/dev-dist/**',
      'coverage/**',
      'e2e/playwright-report/**',
      'e2e/test-results/**',
    ],
  },
  js.configs.recommended,

  // Browser app: TypeScript + React.
  {
    files: ['client/src/**/*.{ts,tsx}', 'client/vite.config.ts'],
    extends: [...tseslint.configs.recommended],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },

  // k6 scripts run in k6's own runtime, not Node or a browser.
  {
    files: ['loadtest/k6.js'],
    languageOptions: { sourceType: 'module', globals: { __ENV: 'readonly' } },
  },

  // Plain browser scripts served as-is from client/public.
  {
    files: ['client/public/**/*.js'],
    languageOptions: { sourceType: 'script', globals: { ...globals.browser } },
    rules: { 'no-unused-vars': ['error', { caughtErrors: 'none' }] },
  },

  // API server and scripts: CommonJS on Node.
  {
    files: ['server/**/*.js'],
    languageOptions: { sourceType: 'commonjs', globals: { ...globals.node } },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },

  // Root tooling and end-to-end tests: ES modules on Node.
  {
    files: ['eslint.config.js', 'scripts/**/*.mjs', 'loadtest/run.mjs', 'e2e/**/*.ts'],
    extends: [...tseslint.configs.recommended],
    languageOptions: { globals: { ...globals.node } },
  },
);
