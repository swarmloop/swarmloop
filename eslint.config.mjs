import { createRequire } from 'node:module';
import eslint from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// The dashboard lint plugins are installed in dashboard/, so resolve them from there.
const dashboardRequire = createRequire(new URL('./dashboard/package.json', import.meta.url));
const nextPlugin = dashboardRequire('@next/eslint-plugin-next');
const reactHooks = dashboardRequire('eslint-plugin-react-hooks');
const jsxA11y = dashboardRequire('eslint-plugin-jsx-a11y');

export default [
  {
    ignores: ['**/dist', '**/.next', '**/node_modules', 'data', 'worktrees', 'docs'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ['dashboard/**'],
    languageOptions: {
      globals: globals.browser,
    },
    plugins: {
      '@next/next': nextPlugin,
      'react-hooks': reactHooks,
      'jsx-a11y': jsxA11y,
    },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      ...jsxA11y.flatConfigs.recommended.rules,
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      eqeqeq: 'error',
      'no-console': 'error',
    },
  },
  {
    // The core rule has no `^_` ignore, so TypeScript files use the typescript-eslint rule above.
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      'no-unused-vars': 'off',
    },
  },
  {
    files: ['server/src/cli/**', 'server/src/main.ts', 'server/src/api-main.ts', 'scripts/**'],
    rules: {
      'no-console': 'off',
    },
  },
  eslintConfigPrettier,
];
