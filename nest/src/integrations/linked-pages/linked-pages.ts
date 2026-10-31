import { Injectable } from '@nestjs/common';
import { IssueBundle, IssueLink } from '../../providers/issue-bundle';
import { isReadable, request } from '../../providers/http';
import { ConfluencePageReader } from './confluence-page.reader';
import { DrivePageReader } from './drive-page.reader';
import { PageReadContext } from './page-reader';
import { PastePageReader } from './paste-page.reader';

@Injectable()
export class LinkedPagesService {
  private readonly drive = new DrivePageReader();

  constructor(private readonly pastePages: PastePageReader) {}

  async take(bundle: IssueBundle, url: string, context: PageReadContext): Promise<boolean> {
    const confluence = new ConfluencePageReader(context.base);
    if (confluence.accepts(url)) {
      bundle.confluence.push(await confluence.read(url, context));
      return true;
    }
    if (this.drive.accepts(url)) {
      bundle.pages.push(await this.drive.read(url, context));
      return true;
    }
    return false;
  }

  async external(url: string, context: PageReadContext): Promise<IssueLink[]> {
    let stored = context.pastes;
    if (stored === undefined) {
      stored = await this.pastePages.savedPastes(context.runKey);
      context.pastes = stored;
    }
    const saved: IssueLink[] = [];
    const response = await request(url, headersFor(url, context.base, context.headers), context.calls);
    if (response.status >= 200 && response.status < 300 && response.body.length > 0) {
      if (isHtmlDocument(response.contentType, response.body)) {
        saved.push({ url, path: '', source: 'link', body: '', encoding: 'utf8' });
        return saved;
      }
      const readable = isReadable(response.contentType, response.body);
      const encoded = encodedBody(response.contentType, response.body);
      saved.push({ url, path: '', source: 'link', body: encoded.body, encoding: encoded.encoding });
      if (readable) {
        return saved;
      }
    }
    if (stored[url]) {
      saved.push({ url, path: '', source: 'paste', body: stored[url], encoding: 'utf8' });
      return saved;
    }
    const body = await this.pastePages.read(url);
    await this.pastePages.rememberPaste(context.runKey, url, body);
    stored[url] = body;
    saved.push({ url, path: '', source: 'paste', body, encoding: 'utf8' });
    return saved;
  }
}

export function headersFor(url: string, base: string, auth: Record<string, string>): Record<string, string> {
  try {
    if (new URL(url).host === new URL(base).host) {
      return auth;
    }
  } catch {
    return { Accept: '*/*' };
  }
  return { Accept: '*/*' };
}

export function encodedBody(contentType: string | null, body: Buffer): { body: string; encoding: 'utf8' | 'base64' } {
  if (isReadable(contentType, body)) {
    return { body: body.toString('utf8'), encoding: 'utf8' };
  }
  return { body: body.toString('base64'), encoding: 'base64' };
}

function isHtmlDocument(contentType: string | null, body: Buffer): boolean {
  if ((contentType ?? '').toLowerCase().includes('html')) {
    return true;
  }
  const start = body.subarray(0, 64).toString('utf8').trimStart().toLowerCase();
  return start.startsWith('<!doctype') || start.startsWith('<html');
}
