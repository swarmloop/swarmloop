import js from '@eslint/js';
import nextPlugin from '@next/eslint-plugin-next';
import prettier from 'eslint-config-prettier/flat';
import jsxA11y from 'eslint-plugin-jsx-a11y';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const sourceFiles = ['**/*.{js,mjs,ts,tsx}'];
const dashboardFiles = ['dashboard/**/*.{js,mjs,ts,tsx}'];

export default tseslint.config(
  {
    ignores: ['**/dist', '**/.next', '**/node_modules', 'data', 'worktrees', 'docs'],
  },
  {
    files: sourceFiles,
    extends: [js.configs.recommended, tseslint.configs.recommended],
    rules: {
      eqeqeq: 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      'no-console': 'error',
    },
  },
  {
    files: ['server/**', 'scripts/**'],
    languageOptions: { globals: globals.node },
  },
  {
    // The contract is compiled by the dashboard too, so it may import only its own files.
    files: ['server/src/contract/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { regex: '^(?!\\./)', message: 'server/src/contract may import only its own files through ./ paths.' },
          ],
        },
      ],
    },
  },
  {
    files: ['server/src/cli/**', 'server/src/main.ts', 'server/src/api-main.ts', 'scripts/**'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['server/src/**/*.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        { object: 'process.stderr', property: 'write', message: 'Log through a Nest Logger instead.' },
        { object: 'process.stdout', property: 'write', message: 'Log through a Nest Logger instead.' },
        { object: 'process', property: 'env', message: 'Read config through AppConfig, or rawEnv() outside Nest.' },
        { object: 'Date', property: 'now', message: 'Read time through Clock.' },
      ],
      'no-restricted-syntax': [
        'error',
        { selector: "NewExpression[callee.name='Date'][arguments.length=0]", message: 'Read time through Clock.' },
      ],
    },
  },
  {
    // Person-facing CLI, bootstrap, and prompt output is written directly, as the no-console exceptions are.
    // The stdout and stderr entries are off here, but the env and clock checks stay on.
    files: [
      'server/src/cli/**',
      'server/src/main.ts',
      'server/src/api-main.ts',
      'server/src/acp/shell.ts',
      'server/src/integrations/linked-pages/paste-page.reader.ts',
    ],
    rules: {
      'no-restricted-properties': [
        'error',
        { object: 'process', property: 'env', message: 'Read config through AppConfig, or rawEnv() outside Nest.' },
        { object: 'Date', property: 'now', message: 'Read time through Clock.' },
      ],
    },
  },
  {
    // The config layer, the clock itself, the entry points, and specs read the raw env and the clock directly.
    files: [
      'server/src/config/**',
      'server/src/core/clock.ts',
      'server/src/main.ts',
      'server/src/api-main.ts',
      '**/*.spec.ts',
      '**/*.spec-helpers.ts',
    ],
    rules: { 'no-restricted-properties': 'off', 'no-restricted-syntax': 'off' },
  },
  {
    files: dashboardFiles,
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    plugins: { '@next/next': nextPlugin, 'react-hooks': reactHooks },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
    },
  },
  {
    files: dashboardFiles,
    rules: {
      'no-restricted-globals': ['error', { name: 'fetch', message: 'Call the API through lib/api.' }],
    },
  },
  {
    files: ['dashboard/lib/api.ts'],
    rules: { 'no-restricted-globals': 'off' },
  },
  {
    files: dashboardFiles,
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.object.name='socket'][callee.property.name=/^(on|off)$/]",
          message: 'Subscribe to socket events only in hooks/use-live-bridge.ts',
        },
      ],
    },
  },
  {
    files: ['dashboard/hooks/use-live-bridge.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    files: ['dashboard/components/**/*.{js,mjs,ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [{ regex: '(^|/)lib/api$', message: 'Components call lib/endpoints, not lib/api.' }] },
      ],
    },
  },
  {
    ...jsxA11y.flatConfigs.recommended,
    files: dashboardFiles,
  },
  {
    // Next.js writes this file, and its reference line is not ours to change.
    files: ['dashboard/next-env.d.ts'],
    rules: { '@typescript-eslint/triple-slash-reference': 'off' },
  },
  prettier,
);
