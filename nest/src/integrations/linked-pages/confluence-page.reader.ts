import { IssuePage } from '../../providers/issue-bundle';
import { request } from '../../providers/http';
import { FetchFailed } from '../../swarmloop-error';
import { PageReadContext, PageReader } from './page-reader';

export class ConfluencePageReader implements PageReader {
  constructor(private readonly base: string) {}

  accepts(url: string): boolean {
    return confluenceId(url, this.base) !== null;
  }

  async read(url: string, context: PageReadContext): Promise<IssuePage> {
    const pageId = confluenceId(url, this.base);
    if (!pageId) {
      throw new FetchFailed(`confluence is not readable: ${url}`, context.calls);
    }
    const contentUrl = `${this.base}/wiki/rest/api/content/${pageId}?expand=body.storage`;
    const response = await request(contentUrl, context.headers, context.calls);
    if (response.status < 200 || response.status >= 300) {
      throw new FetchFailed(`confluence is not readable: ${url}`, context.calls);
    }
    const raw = response.body.toString('utf8');
    const page = JSON.parse(raw) as { title?: string; body?: { storage?: { value?: string } } };
    return {
      source: 'confluence',
      id: pageId,
      title: page.title ?? pageId,
      path: '',
      url,
      body: page.body?.storage?.value ?? raw,
      encoding: 'utf8',
    };
  }
}

function confluenceId(url: string, base: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.host !== new URL(base).host) {
      return null;
    }
    return parsed.pathname.match(/\/pages\/(\d+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}
