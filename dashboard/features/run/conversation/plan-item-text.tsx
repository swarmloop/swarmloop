'use client';

import { type ReactElement, useState } from 'react';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import { planItemParts } from '@contract/plan-item';
import { plainText } from './conversation-words';

/** A list of paths longer than this shows its first paths and a button for the rest. */
const SHOWN_FILES = 5;

/** A plan item for a person: its title, then its files one per line in the code font (the rest folded), then its proof. */
export function PlanItemText({ item }: { item: string }): ReactElement {
  const { text, files, proof } = planItemParts(item);
  const [open, setOpen] = useState(false);
  if (files.length === 0) {
    return <>{plainText(text)}</>;
  }
  const title = text.slice(0, text.indexOf(' - files: '));
  const shown = open ? files : files.slice(0, SHOWN_FILES);
  const hidden = files.length - shown.length;
  return (
    <>
      {plainText(title)}
      <Box component="ul" sx={{ m: 0, pl: 2, listStyle: 'none', fontSize: 13 }}>
        {shown.map((file) => (
          <Box component="li" key={file} sx={{ overflowWrap: 'anywhere', fontFamily: 'var(--font-mono)' }}>
            {file}
          </Box>
        ))}
      </Box>
      {hidden > 0 ? (
        <Button size="small" onClick={() => setOpen(true)}>
          {`and ${hidden} more files`}
        </Button>
      ) : null}
      {proof !== null ? <Box>{`proof: ${plainText(proof)}`}</Box> : null}
    </>
  );
}
