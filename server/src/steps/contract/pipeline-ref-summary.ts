import { parsePipelineRefs } from '../pipeline/pipeline-report';
import { firstLine } from './artifact';

/** The summary of a pipeline_ref document: each watched ref, with the first 7 of its commit when it has one. */
export function pipelineRefSummary(body: string): string {
  const refs = parsePipelineRefs(body);
  if (refs.length === 0) {
    return firstLine(body);
  }
  return refs.map((item) => (item.sha ? `${item.ref} at ${item.sha.slice(0, 7)}` : item.ref)).join(', ');
}
