import type { IssuePage } from '../issue-tracker/issue-bundle';
import { request } from '../http';
import { FetchFailed } from '../../core/swarmloop-error';
import { driveTarget, loadDrive } from './drive';
import type { PageReadContext, PageReader } from './page-reader';

export class DrivePageReader implements PageReader {
  accepts(url: string): boolean {
    return driveTarget(url) !== null;
  }

  async read(url: string, context: PageReadContext): Promise<IssuePage> {
    try {
      const loaded = await loadDrive(url, (exportUrl) =>
        request(context.clock, exportUrl, { Accept: '*/*' }, context.calls),
      );
      return {
        source: 'drive',
        id: loaded.id,
        title: loaded.title,
        path: '',
        url,
        body: loaded.body,
        encoding: loaded.encoding,
      };
    } catch (error) {
      if (error instanceof FetchFailed) {
        throw error;
      }
      const message = error instanceof Error ? error.message : `drive is not readable: ${url}`;
      throw new FetchFailed(message, context.calls);
    }
  }
}
