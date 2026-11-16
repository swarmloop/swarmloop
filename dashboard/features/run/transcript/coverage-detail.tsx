import type { ReactElement } from 'react';
import Box from '@mui/material/Box';
import type { CoveredRequirement, Requirement } from '@contract/requirement-list';
import { MarkdownBody } from '../../../components/ui/markdown-body';

function parseList<T extends Requirement>(body: string): T[] | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const valid = value.every(
    (entry: unknown) =>
      !!entry &&
      typeof entry === 'object' &&
      typeof (entry as Requirement).id === 'string' &&
      typeof (entry as Requirement).text === 'string',
  );
  return valid ? (value as T[]) : null;
}

function coveredBy(entry: CoveredRequirement): string {
  return Array.isArray(entry.items) && entry.items.length > 0 ? entry.items.join('; ') : 'not covered';
}

/** The requirements of a run, each as `R<n> <text>`. With a coverage body, each one also shows what covers it. */
export function CoverageDetail({ kind, body }: { kind: string; body: string }): ReactElement {
  const list = parseList<CoveredRequirement>(body);
  if (!list) {
    return <MarkdownBody text={body} />;
  }
  const withCoverage = kind === 'requirement_coverage';
  return (
    <Box sx={{ minWidth: 0 }}>
      {list.map((entry, index) => (
        <Box key={index} sx={{ mb: 0.5, overflowWrap: 'anywhere' }}>
          <Box>{`${entry.id} ${entry.text}`}</Box>
          {withCoverage ? <Box sx={{ pl: 2, color: 'text.secondary' }}>{`covered by: ${coveredBy(entry)}`}</Box> : null}
        </Box>
      ))}
    </Box>
  );
}
