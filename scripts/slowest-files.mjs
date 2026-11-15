import { relative, sep } from 'node:path';

/**
 * Formats the slowest test files of a run as a block of text.
 * `files` is a list of { path, ms } with absolute paths; `root` is the package folder.
 * Returns '' for an empty list.
 */
export function formatSlowestFiles(root, files, limit = 10) {
  if (files.length === 0) {
    return '';
  }
  const slowest = [...files].sort((a, b) => b.ms - a.ms || a.path.localeCompare(b.path)).slice(0, limit);
  const lines = slowest.map((file) => {
    const seconds = (file.ms / 1000).toFixed(1).padStart(6);
    return `${seconds} s  ${relative(root, file.path).split(sep).join('/')}`;
  });
  return ['slowest test files', ...lines, ''].join('\n');
}
