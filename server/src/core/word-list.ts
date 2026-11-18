/** Names as words for a person: `a`, `a and b`, `a, b and c`. */
export function wordList(names: string[]): string {
  if (names.length <= 1) {
    return names[0] ?? '';
  }
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
