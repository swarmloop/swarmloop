const FILES = ' - files: ';
const PROOF = ' - proof: ';

/** The one format of a task's plan item: `title - files: a, b - proof: p`. */
export function planItemText({ title, files, proof }: { title: string; files: string[]; proof: string }): string {
  return `${title}${FILES}${files.join(', ')}${PROOF}${proof}`;
}

/** What `planItemText` wrote, read back: its title (the whole item when it has no files part), its files and its proof. */
export function planItemParts(item: string): { title: string; files: string[]; proof: string | null } {
  const filesAt = item.indexOf(FILES);
  if (filesAt < 0) {
    return { title: item, files: [], proof: null };
  }
  const rest = item.slice(filesAt + FILES.length);
  const proofAt = rest.lastIndexOf(PROOF);
  const list = proofAt < 0 ? rest : rest.slice(0, proofAt);
  return {
    title: item.slice(0, filesAt),
    files: list
      .split(', ')
      .map((file) => file.trim())
      .filter((file) => file !== ''),
    proof: proofAt < 0 ? null : rest.slice(proofAt + PROOF.length),
  };
}
