/** Every test file has one of these name shapes, whatever the language or the tool. */
const TEST_NAMES = [/\.(test|spec)\.\w+$/, /^test_.+\.\w+$/, /_test\.\w+$/];
const MAX_PATHS = 50;

/** The test file paths a log names, as it wrote them. */
export function testPaths(trace: string): string[] {
  const found = new Set<string>();
  for (const match of trace.matchAll(/[\w@.+/-]+/g)) {
    const path = match[0].replace(/\.+$/, '');
    const name = path.slice(path.lastIndexOf('/') + 1);
    if (!path.includes('..') && TEST_NAMES.some((pattern) => pattern.test(name))) found.add(path);
  }
  return [...found].slice(0, MAX_PATHS);
}
