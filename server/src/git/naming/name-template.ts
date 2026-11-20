/** The values a template can name. A placeholder with no value renders empty. */
export type NameValues = Partial<
  Record<'type' | 'scope' | 'subject' | 'summary' | 'ticket' | 'slug' | 'key' | 'task', string>
>;

const PLACEHOLDER = /\{(\w+)\}/g;
const OPTIONAL_PART = /\[([^[\]]*)\]/g;

/** Renders a template. A `[...]` part is dropped when a placeholder in it is empty. */
export function renderTemplate(template: string, values: NameValues): string {
  const value = (name: string): string => (values as Record<string, string | undefined>)[name] ?? '';
  const fill = (text: string): string => text.replace(PLACEHOLDER, (_all, name: string) => value(name));
  const withParts = template.replace(OPTIONAL_PART, (_all, part: string) => {
    const names = [...part.matchAll(PLACEHOLDER)].map((match) => match[1] ?? '');
    return names.some((name) => value(name) === '') ? '' : part;
  });
  return fill(withParts);
}
