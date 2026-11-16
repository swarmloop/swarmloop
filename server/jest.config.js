/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '(src|test)/.*\\.(spec|e2e\\.spec)\\.ts$',
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.jest.json' }],
  },
  cacheDirectory: '<rootDir>/.jest-cache',
  testEnvironment: 'node',
  globalSetup: '<rootDir>/jest.global-setup.js',
  globalTeardown: '<rootDir>/jest.global-teardown.js',
  setupFiles: ['<rootDir>/jest.setup.js'],
  testTimeout: 20000,
  reporters: ['default', '<rootDir>/../scripts/jest-slowest-files.mjs'],
};
