import { formatSlowestFiles } from './slowest-files.mjs';

// Vitest reporter: prints the slowest test files at the end of a run. It never changes the exit code.
export default class VitestSlowestFiles {
  onInit(ctx) {
    this.root = ctx.config.root;
  }

  onFinished(files = []) {
    try {
      const block = formatSlowestFiles(
        this.root,
        files.map((file) => ({ path: file.filepath, ms: file.result?.duration ?? 0 })),
      );
      if (block !== '') {
        process.stdout.write(`\n${block}`);
      }
    } catch (error) {
      process.stderr.write(`slowest test files: not shown (${error.message})\n`);
    }
  }
}
