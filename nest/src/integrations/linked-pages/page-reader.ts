import { IssuePage } from '../../providers/issue-bundle';
import { HttpCallDraft } from '../../swarmloop-error';

export interface PageReadContext {
  runKey: string;
  calls: HttpCallDraft[];
  headers: Record<string, string>;
  base: string;
  pastes?: Record<string, string>;
}

export interface PageReader {
  accepts(url: string): boolean;
  read(url: string, context: PageReadContext): Promise<IssuePage>;
}
