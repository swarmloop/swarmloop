interface Linked {
  key?: string;
  summary?: string;
  url?: string;
}

interface Page {
  title?: string;
  id?: string;
  url?: string;
}

interface File {
  name?: string;
  url?: string | null;
}

/** The requirements document of a run, read for a person. */
export interface RequirementsView {
  /** The ticket key and summary, or the first line of the prompt without markdown. */
  title: string;
  /** `2 tickets · 1 pages · plan: 9 items`, only the parts that are present. */
  meta: string;
  /** `plan approved` or `plan not approved yet`. Empty when there is no plan. */
  approval: string;
  prompt: string;
  tickets: Linked[];
  epics: Linked[];
  pages: Page[];
  files: File[];
  plan: { name: string; overview: string; items: string[]; approved: boolean } | null;
}

const TITLE_CHARS = 160;

function list<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value.filter((item) => item && typeof item === 'object') as T[]) : [];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** The first line of a markdown text, without its marks. */
export function plainFirstLine(markdown: string): string {
  const line = markdown.split('\n').find((item) => item.replace(/[#>*`\-_\s]/g, '') !== '') ?? '';
  return line
    .replace(/^[\s#>*\-+]+/, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*`_]/g, '')
    .trim()
    .slice(0, TITLE_CHARS);
}

function ticketTitle(ticket: Linked): string {
  return [ticket.key, ticket.summary].filter(Boolean).join(' ');
}

/** Reads a requirements document. Null when the body is not a JSON object. */
export function requirementsView(body: string): RequirementsView | null {
  let record: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    record = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const tickets = list<Linked>(record.tickets);
  const pages = list<Page>(record.pages);
  const files = list<File>(record.files);
  const epics = [...list<Linked>(record.epics), ...list<Linked>([record.epic])];
  const prompt = text(record.prompt);
  const rawPlan = record.plan && typeof record.plan === 'object' ? (record.plan as Record<string, unknown>) : null;
  const items = rawPlan && Array.isArray(rawPlan.items) ? rawPlan.items.filter((i) => typeof i === 'string') : [];
  const plan = rawPlan
    ? {
        name: text(rawPlan.name),
        overview: text(rawPlan.overview),
        items,
        approved: rawPlan.decision === 'approve',
      }
    : null;
  const counts = [
    tickets.length > 0 ? `${tickets.length} tickets` : '',
    pages.length > 0 ? `${pages.length} pages` : '',
    files.length > 0 ? `${files.length} files` : '',
    plan && plan.items.length > 0 ? `plan: ${plan.items.length} items` : '',
  ].filter(Boolean);
  const first = tickets.map(ticketTitle).find((title) => title !== '');
  return {
    title: first ?? plainFirstLine(prompt),
    meta: counts.join(' · '),
    approval: plan ? (plan.approved ? 'plan approved' : 'plan not approved yet') : '',
    prompt,
    tickets,
    epics,
    pages,
    files,
    plan,
  };
}
