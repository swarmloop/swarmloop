/** A file name that is safe on disk: only letters, digits, dot, underscore and dash, at most 80 characters. */
export function cleanFileName(name: string, fallback: string): string {
  const clean = name
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^-+/, '')
    .slice(0, 80);
  return clean.length > 0 && clean !== '.' && clean !== '..' ? clean : fallback;
}
