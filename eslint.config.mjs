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
    files: ['server/src/cli/**', 'server/src/main.ts', 'server/src/api-main.ts', 'scripts/**'],
    rules: { 'no-console': 'off' },
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
    ...jsxA11y.flatConfigs.recommended,
    files: dashboardFiles,
  },
  prettier,
);
