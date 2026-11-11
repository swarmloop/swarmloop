import { useState, type ReactElement } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Link from '@mui/material/Link';
import type { AttemptCheck } from '@contract/step-events';
import { duration } from '../../../lib/format';
import { SPACE } from './tokens';

function CheckRow({ check }: { check: AttemptCheck }): ReactElement {
  const [open, setOpen] = useState(false);
  const opens = check.status === 'failed' && (check.annotations.length > 0 || check.summary !== '');
  return (
    <Box component="li" sx={{ minWidth: 0, overflowWrap: 'anywhere' }}>
      {[check.name, check.app, check.status, duration(check.durationMs)].filter(Boolean).join(' · ')}
      {check.url ? (
        <>
          {' · '}
          <Link href={check.url} target="_blank" rel="noreferrer">
            {`Open ${check.name}`}
          </Link>
        </>
      ) : null}
      {opens ? (
        <Button size="small" color="inherit" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          {`${open ? 'Hide' : 'Show'} annotations of ${check.name}`}
        </Button>
      ) : null}
      {open ? (
        <Box component="ul" aria-label={`Annotations of ${check.name}`} sx={{ pl: SPACE.pad }}>
          {check.summary ? <li>{check.summary}</li> : null}
          {check.annotations.map((note, index) => (
            <li
              key={index}
            >{`${note.path}:${note.line} · ${note.level} · ${note.title ? `${note.title}: ` : ''}${note.message}`}</li>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}

/** Every check of the commit that the pipeline step watched; a failed one opens its annotations. */
export function CheckList({ checks }: { checks: AttemptCheck[] }): ReactElement {
  return (
    <Box component="ul" aria-label="Checks" sx={{ m: 0, pl: SPACE.pad, fontSize: 'caption.fontSize' }}>
      {checks.map((check, index) => (
        <CheckRow key={index} check={check} />
      ))}
    </Box>
  );
}
