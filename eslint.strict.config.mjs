import baseConfig from './eslint.config.mjs';
import tseslint from 'typescript-eslint';

const typedFiles = ['**/*.{ts,tsx}'];
// dashboard/tsconfig.json excludes these test and config files. dashboard/tsconfig.test.json includes them.
const dashboardTestFiles = ['dashboard/**/*.test.{ts,tsx}', 'dashboard/vitest.*.ts', 'dashboard/test/fake-socket.ts'];
// Size rules are warnings until part 51, after the split parts (35-38) have broken up the large legacy files.
const maxLines = (max) => ['warn', { max, skipBlankLines: true, skipComments: true }];
const typedRules = {
  '@typescript-eslint/no-floating-promises': 'error',
  '@typescript-eslint/no-misused-promises': 'error',
  '@typescript-eslint/await-thenable': 'error',
  '@typescript-eslint/switch-exhaustiveness-check': 'error',
  '@typescript-eslint/consistent-type-imports': 'error',
  '@typescript-eslint/explicit-module-boundary-types': 'error',
  '@typescript-eslint/no-explicit-any': 'error',
  'max-lines': maxLines(400),
  complexity: ['warn', 20],
};

export default tseslint.config(
  ...baseConfig,
  {
    files: typedFiles,
    ignores: dashboardTestFiles,
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: typedRules,
  },
  {
    files: dashboardTestFiles,
    extends: [tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: { project: './dashboard/tsconfig.test.json', tsconfigRootDir: import.meta.dirname },
    },
    rules: typedRules,
  },
  {
    files: ['**/*.spec.ts', '**/*.test.ts', '**/*.test.tsx'],
    rules: {
      '@typescript-eslint/no-floating-promises': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      complexity: 'off',
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
