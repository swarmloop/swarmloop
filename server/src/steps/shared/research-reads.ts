import type { ResearchResult } from '../../agent-result/definitions/research';
import { renderImpact } from '../research/research-record';

/**
 * The impact list later steps read. It comes from the object of `research_result`; a run that started before
 * results were stored has the rendered `impact` document only, and that body is already what the steps take.
 */
export function storedImpact(result: ResearchResult | null, impactBody: string | null): string | null {
  return result ? renderImpact(result.impact) : impactBody;
}
