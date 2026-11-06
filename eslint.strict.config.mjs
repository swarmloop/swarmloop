import baseConfig from './eslint.config.mjs';
import tseslint from 'typescript-eslint';

const typedFiles = ['**/*.{ts,tsx}'];
const testFiles = ['**/*.spec.ts', '**/*.spec-helpers.ts', '**/*.test.ts', '**/*.test.tsx'];
// dashboard/tsconfig.json excludes these test and config files. dashboard/tsconfig.test.json includes them.
const dashboardTestFiles = [
  'dashboard/**/*.test.{ts,tsx}',
  'dashboard/vitest.*.ts',
  'dashboard/test/fake-socket.ts',
  'dashboard/test/viewport.ts',
];
const maxLines = (max) => ['error', { max, skipBlankLines: true, skipComments: true }];
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
      parserOptions: {
        projectService: { allowDefaultProject: ['server/test/e2e/*.ts'] },
        tsconfigRootDir: import.meta.dirname,
      },
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
    files: testFiles,
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
    files: testFiles,
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
  {
    // Next.js writes this file, and its reference line is not ours to change (the base config says the same).
    files: ['dashboard/next-env.d.ts'],
    rules: { '@typescript-eslint/triple-slash-reference': 'off' },
  },
);
