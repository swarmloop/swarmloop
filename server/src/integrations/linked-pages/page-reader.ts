import type { IssuePage } from '../issue-tracker/issue-bundle';
import type { Clock } from '../../core/clock';
import type { HttpCallDraft } from '../../core/swarmloop-error';

export interface PageReadContext {
  runKey: string;
  calls: HttpCallDraft[];
  clock: Clock;
  headers: Record<string, string>;
  base: string;
  pastes?: Record<string, string>;
  /** The person whose connections read the page, when the run has one. */
  login?: string | null;
}

export interface PageReader {
  accepts(url: string): boolean;
  read(url: string, context: PageReadContext): Promise<IssuePage>;
}
