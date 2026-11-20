/** Makes a task id from its title: lowercase letters, digits and dashes, unique among the existing ids. */
export function taskSlug(title: string, existing: readonly string[]): string {
  const base =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'task';
  let slug = base;
  for (let n = 2; existing.includes(slug); n += 1) {
    slug = `${base}-${n}`;
  }
  return slug;
}
