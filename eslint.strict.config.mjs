import tseslint from 'typescript-eslint';
import base from './eslint.config.mjs';

export default [
  ...base,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: true }],
      complexity: ['error', 20],
    },
  },
  {
    files: ['**/*.spec.ts'],
    rules: {
      'max-lines': ['error', { max: 800, skipBlankLines: true, skipComments: true }],
    },
  },
  {
    files: ['server/**', 'packages/**'],
    rules: {
      'no-restricted-syntax': ['error', { selector: 'ExportDefaultDeclaration', message: 'Use a named export.' }],
    },
  },
];
