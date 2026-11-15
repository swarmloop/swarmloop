// Jest loads this file as CommonJS, and the helper is TypeScript that Jest's ts-jest transform loads through require.
/* eslint-disable @typescript-eslint/no-require-imports */
const { mkdtempSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');

module.exports = async () => {
  const { buildMigratedDatabase } = require('./src/testing/migrated-database.spec-helpers');
  const directory = mkdtempSync(join(tmpdir(), 'swarmloop-test-db-'));
  process.env.SWARMLOOP_TEST_DATABASE_TEMPLATE = await buildMigratedDatabase(directory);
};
