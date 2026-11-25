// Jest loads this file as CommonJS, and the helper is TypeScript that Jest's ts-jest transform loads through require.
/* eslint-disable @typescript-eslint/no-require-imports */
const { mkdtempSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');

// Git starts `maintenance run --auto` as a child after each commit, merge, rebase, fetch and push. A spec never reads
// its result, and a flow spec starts hundreds of them. Every worker inherits this env, so every git a spec starts skips it.
function turnOffGitUpkeep() {
  const first = Number(process.env.GIT_CONFIG_COUNT) || 0;
  const entries = [
    ['gc.auto', '0'],
    ['maintenance.auto', 'false'],
  ];
  entries.forEach(([key, value], index) => {
    process.env[`GIT_CONFIG_KEY_${first + index}`] = key;
    process.env[`GIT_CONFIG_VALUE_${first + index}`] = value;
  });
  process.env.GIT_CONFIG_COUNT = String(first + entries.length);
}

module.exports = async () => {
  turnOffGitUpkeep();
  const { buildMigratedDatabase } = require('./src/testing/migrated-database.spec-helpers');
  const directory = mkdtempSync(join(tmpdir(), 'swarmloop-test-db-'));
  process.env.SWARMLOOP_TEST_DATABASE_TEMPLATE = await buildMigratedDatabase(directory);
};
