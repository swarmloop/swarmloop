import type { DocumentRepository } from '../../history/document.repository';
import { CODE_REVIEWERS } from '../../contract/steps';
import { REVIEWS } from '../contract/artifacts';
import type { Issue } from '../contract/step-contract';
import { issueOf } from '../shared/handoff';

export const NOT_DELIVERED = 'nothing changed and the task is not delivered';

type UnchangedOutcome = { delivered: string } | { issues: Issue[] };

const MET = /^\W*(?:\d+\.\s*)?met:\s*.*\(([^()]+)\)\s*$/gim;

/** The locations the requirements review gives for the lines it marks `met`. */
function locations(body: string): string[] {
  return [...body.matchAll(MET)].map((match) => match[1].trim());
}

/**
 * What an unchanged tree means. It is delivered only when the last review round passed every reviewer
 * and its requirements review says where each required behavior already is. Any other unchanged tree goes back to implement.
 */
export async function unchangedOutcome(documents: DocumentRepository, key: string): Promise<UnchangedOutcome> {
  const requirements = await documents.latestBody(key, REVIEWS.of('requirements'));
  if (requirements && /^decision:\s*ok\b/m.test(requirements)) {
    const found = locations(requirements);
    const others = await Promise.all(
      CODE_REVIEWERS.filter((name) => name !== 'requirements').map((name) =>
        documents.latestBody(key, REVIEWS.of(name)),
      ),
    );
    if (found.length > 0 && others.every((body) => body === null || /^decision:\s*ok\b/m.test(body))) {
      return { delivered: [...new Set(found)].join('; ') };
    }
  }
  return { issues: [issueOf('commit', NOT_DELIVERED, `${NOT_DELIVERED}\n`)] };
}
