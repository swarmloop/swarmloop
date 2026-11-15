import { useState, type ReactElement } from 'react';
import Button from '@mui/material/Button';
import { shortLine } from '@contract/short-text';

/** The text cut to `max` characters with a '…'. A cut text is a button that opens the whole text and closes it again. */
export function ShortText({ text, max }: { text: string; max: number }): ReactElement {
  const [whole, setWhole] = useState(false);
  if (text.length <= max) {
    return <>{text}</>;
  }
  return (
    <Button
      size="small"
      color="inherit"
      aria-expanded={whole}
      onClick={() => setWhole(!whole)}
      sx={{
        display: 'inline',
        minWidth: 0,
        p: 0,
        textTransform: 'none',
        font: 'inherit',
        textAlign: 'start',
        overflowWrap: 'anywhere',
      }}
    >
      {whole ? text : shortLine(text, max)}
    </Button>
  );
}
