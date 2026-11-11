import type { ReactElement } from 'react';
import { useQuery } from '@tanstack/react-query';
import Box from '@mui/material/Box';
import Table from '@mui/material/Table';
import TableBody from '@mui/material/TableBody';
import TableCell from '@mui/material/TableCell';
import TableRow from '@mui/material/TableRow';
import { MarkdownBody } from '../../../components/ui/markdown-body';
import { getHistory } from '../../../lib/endpoints';
import { RequirementsDetail } from './requirements-detail';

const HISTORY_STALE_MS = 60_000;

/** A value as text a person reads: nested lists and objects as `key: value` parts, never as JSON. */
function cell(value: unknown): string {
  if (Array.isArray(value)) {
    return value.map(cell).join(', ');
  }
  if (value && typeof value === 'object') {
    return Object.entries(value)
      .map(([key, item]) => `${key}: ${cell(item)}`)
      .join('; ');
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** A JSON object or a list of objects as a table. Null when the body is not JSON of that shape. */
function jsonTable(body: string): ReactElement | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object') {
    return null;
  }
  const rows: [string, unknown][] = Array.isArray(value)
    ? value.map((item, index) => [String(index + 1), item])
    : Object.entries(value);
  return (
    <Table size="small">
      <TableBody>
        {rows.map(([name, item]) => (
          <TableRow key={name}>
            <TableCell sx={{ verticalAlign: 'top', whiteSpace: 'nowrap' }}>{name}</TableCell>
            <TableCell sx={{ overflowWrap: 'anywhere' }}>{cell(item)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** The document a card points at: the requirements as a structured view, JSON as a table, anything else as markdown. */
export function DocumentBody({ kind, body }: { kind: string; body: string }): ReactElement {
  if (kind === 'requirements') {
    return <RequirementsDetail body={body} />;
  }
  return jsonTable(body) ?? <MarkdownBody text={body} />;
}

/** The latest stored document of a kind. One read of the history serves every card of the run. */
export function DocumentDetail({ runKey, kind }: { runKey: string; kind: string }): ReactElement {
  const history = useQuery({
    queryKey: ['history', runKey],
    queryFn: () => getHistory(runKey),
    staleTime: HISTORY_STALE_MS,
    refetchOnWindowFocus: false,
  });
  if (history.isPending) {
    return <Box component="span">loading document</Box>;
  }
  const body = history.data?.documents.filter((document) => document.kind === kind).at(-1)?.body;
  return body === undefined ? (
    <Box component="span">document not stored</Box>
  ) : (
    <DocumentBody kind={kind} body={body} />
  );
}
