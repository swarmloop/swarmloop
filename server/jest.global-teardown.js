// Jest loads this file as CommonJS, so it uses require for node built-ins.
/* eslint-disable @typescript-eslint/no-require-imports */
const { rmSync } = require('fs');
const { dirname } = require('path');

module.exports = async () => {
  const template = process.env.SWARMLOOP_TEST_DATABASE_TEMPLATE;
  if (template) rmSync(dirname(dirname(template)), { recursive: true, force: true });
};
