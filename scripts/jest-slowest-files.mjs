import { formatSlowestFiles } from './slowest-files.mjs';

// Jest reporter: prints the slowest test files at the end of a run. It never changes the exit code.
export default class JestSlowestFiles {
  constructor(globalConfig) {
    this.rootDir = globalConfig.rootDir;
  }

  onRunComplete(_contexts, results) {
    try {
      const files = results.testResults.map((result) => ({
        path: result.testFilePath,
        ms: result.perfStats.end - result.perfStats.start,
      }));
      const block = formatSlowestFiles(this.rootDir, files);
      if (block !== '') {
        process.stdout.write(`\n${block}`);
      }
    } catch (error) {
      process.stderr.write(`slowest test files: not shown (${error.message})\n`);
    }
  }
}
