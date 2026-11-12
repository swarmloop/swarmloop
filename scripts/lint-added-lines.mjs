import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const STRICT_CONFIG = 'eslint.strict.config.mjs';

const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 28 });

/** Maps each file to the [first, last] line ranges the diff against `base` adds or modifies. */
function addedRanges(root, base, files) {
  const ranges = new Map(files.map((file) => [file, []]));
  const diff = git(root, ['diff', '-U0', '--no-color', '--no-renames', base, '--', ...files]);
  let current = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      current = ranges.get(line.slice(4).replace(/\t.*$/, '').replace(/^b\//, '')) ?? null;
      continue;
    }
    const hunk = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk && current) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      if (count > 0) current.push([start, start + count - 1]);
    }
  }
  // A file git does not track yet has no diff: all of it is new.
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', ...files]).split('\0');
  for (const file of untracked.filter(Boolean)) ranges.get(file)?.push([1, Infinity]);
  return ranges;
}

/**
 * Lints `files` with the strict config. An error in a changed file always fails; a warning fails only on a line
 * the change added or modified since `base`. Returns the kept results and the formatted report.
 */
export async function lintAddedLines({ root, base, files, fix = false }) {
  const eslint = new ESLint({ cwd: root, overrideConfigFile: resolve(root, STRICT_CONFIG), fix });
  const results = await eslint.lintFiles(files);
  if (fix) await ESLint.outputFixes(results);
  const ranges = addedRanges(root, base, files);
  const kept = [];
  for (const result of results) {
    const file = result.filePath.slice(root.length + 1);
    const added = ranges.get(file) ?? [];
    const messages = result.messages.filter(
      (message) => message.severity === 2 || added.some(([from, to]) => message.line >= from && message.line <= to),
    );
    if (messages.length) kept.push({ ...result, messages });
  }
  const formatter = await eslint.loadFormatter('stylish');
  return { kept, report: await formatter.format(kept) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const fix = args[0] === '--fix';
  const [base, ...files] = fix ? args.slice(1) : args;
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const { kept, report } = await lintAddedLines({ root, base, files, fix });
  if (report) process.stdout.write(report);
  process.exitCode = kept.length ? 1 : 0;
}
