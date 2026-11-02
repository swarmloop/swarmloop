'use client';

import Markdown from 'react-markdown';
import Box from '@mui/material/Box';

export function MarkdownBody({ text }: { text: string }) {
  const json = prettyJson(text);
  if (json) {
    return (
      <Box component="pre" sx={{ overflow: 'auto', whiteSpace: 'pre-wrap', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
        {json}
      </Box>
    );
  }
  return (
    <Box
      sx={{
        fontSize: 14,
        lineHeight: 1.6,
        '& pre': { overflow: 'auto', bgcolor: 'background.default', p: 1.5, borderRadius: 1, fontFamily: 'var(--font-mono)', fontSize: 12 },
        '& code': { fontFamily: 'var(--font-mono)', fontSize: 12 },
        '& p': { my: 1 },
      }}
    >
      <Markdown>{text}</Markdown>
    </Box>
  );
}

function prettyJson(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return null;
  }
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return null;
  }
}
