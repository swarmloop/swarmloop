import baseConfig from './eslint.config.mjs';
import tseslint from 'typescript-eslint';

const typedFiles = ['**/*.{ts,tsx}'];
const maxLines = (max) => ['error', { max, skipBlankLines: true, skipComments: true }];

export default tseslint.config(
  ...baseConfig,
  {
    files: typedFiles,
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      'max-lines': maxLines(400),
      complexity: ['error', 20],
    },
  },
  {
    files: ['**/*.spec.ts', '**/*.test.ts', '**/*.test.tsx'],
    rules: { 'max-lines': maxLines(800) },
  },
  {
    files: ['server/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ExportDefaultDeclaration',
          message: 'Use a named export instead of export default.',
        },
      ],
    },
  },
);
