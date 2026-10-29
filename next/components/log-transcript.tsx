'use client';

import { ReactNode, useEffect, useRef, useState } from 'react';
import Box from '@mui/material/Box';
import type { Theme } from '@mui/material/styles';
import { LogMessage, logMessages } from '../lib/readable-log';

export function LogTranscript({ raw }: { raw: string }) {
  const messages = logMessages(raw);
  if (messages.length === 0) {
    return null;
  }
  return (
    <Box sx={{ display: 'grid', gap: 1 }}>
      {messages.map((message, index) => (
        <Message key={`${message.type}-${index}`} message={message} />
      ))}
    </Box>
  );
}

const FOLDED_HEIGHT = 140;

function Message({ message }: { message: LogMessage }) {
  const body = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [tall, setTall] = useState(false);
  const code = message.code === 'shell' || message.code === 'json';
  useEffect(() => {
    const node = body.current;
    if (!node) {
      return;
    }
    setTall(node.scrollHeight > FOLDED_HEIGHT);
  }, [message.text]);
  return (
    <Box
      onClick={() => {
        if (!tall || window.getSelection()?.toString()) {
          return;
        }
        setOpen((value) => !value);
      }}
      sx={{ border: 1, borderColor: 'divider', borderRadius: 1, overflow: 'hidden', cursor: tall ? 'pointer' : 'default' }}
    >
      <Box
        sx={{
          px: 1.25,
          py: 0.4,
          bgcolor: (theme) => headerFill(message.type, theme),
          color: 'text.secondary',
          fontFamily: 'var(--font-mono)',
          fontSize: 11,
          letterSpacing: '0.04em',
        }}
      >
        {message.type}
      </Box>
      <Box sx={{ position: 'relative' }}>
        <Box ref={body} sx={{ maxHeight: tall && !open ? FOLDED_HEIGHT : 'none', overflow: 'hidden' }}>
          {code ? message.code === 'shell' ? <ShellCode text={message.text} /> : <JsonCode text={message.text} /> : <Prose text={message.text} />}
        </Box>
        {tall && !open ? (
          <Box
            sx={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 0,
              height: 48,
              background: (theme) => `linear-gradient(to bottom, transparent, ${theme.vars?.palette.background.paper ?? theme.palette.background.paper} 72%)`,
              pointerEvents: 'none',
            }}
          />
        ) : null}
      </Box>
      {tall ? (
        <Box
          sx={{
            px: 1.25,
            py: 0.6,
            textAlign: 'center',
            borderTop: 1,
            borderColor: 'divider',
            bgcolor: (theme) => headerFill('thinking', theme),
            color: 'secondary.main',
            fontFamily: 'var(--font-mono)',
            fontSize: 11,
            letterSpacing: '0.06em',
          }}
        >
          {open ? 'less' : 'more'}
        </Box>
      ) : null}
    </Box>
  );
}

function Prose({ text }: { text: string }) {
  return (
    <Box sx={{ px: 1.25, py: 1, display: 'grid', gap: 1 }}>
      {pieces(text).map((piece, index) =>
        piece.lang ? (
          piece.lang === 'json' ? (
            <JsonCode key={index} text={piece.body} />
          ) : (
            <PlainCode key={index} text={piece.body} />
          )
        ) : (
          <Box key={index} sx={{ whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.5 }}>
            {piece.body}
          </Box>
        ),
      )}
    </Box>
  );
}

function ShellCode({ text }: { text: string }) {
  const [command, ...rest] = text.split('\n');
  const output = rest.join('\n');
  return (
    <Box component="pre" sx={codeSx}>
      <Box component="span" sx={{ color: 'text.primary' }}>
        {command}
      </Box>
      {output ? <Box component="span" sx={{ color: 'text.secondary' }}>{`\n${output}`}</Box> : null}
    </Box>
  );
}

function PlainCode({ text }: { text: string }) {
  return (
    <Box component="pre" sx={codeSx}>
      {text}
    </Box>
  );
}

function JsonCode({ text }: { text: string }) {
  return (
    <Box component="pre" sx={codeSx}>
      {jsonTokens(text)}
    </Box>
  );
}

function jsonTokens(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}\[\],:]|\s+|[^\s"{}\[\],:]+/g;
  const parts = text.match(pattern) ?? [text];
  parts.forEach((part, index) => {
    const next = parts.slice(index + 1).find((item) => item.trim() !== '');
    const key = part.startsWith('"') && next === ':';
    const color = key ? 'secondary.main' : part.startsWith('"') ? 'primary.main' : /^-?\d/.test(part) ? 'warning.main' : /^[{}\[\],:]$/.test(part) ? 'text.secondary' : 'text.primary';
    nodes.push(
      <Box key={index} component="span" sx={{ color }}>
        {part}
      </Box>,
    );
  });
  return nodes;
}

function pieces(text: string): { lang: string | null; body: string }[] {
  const found: { lang: string | null; body: string }[] = [];
  const fence = /```([a-zA-Z0-9]*)\n([\s\S]*?)```/g;
  let last = 0;
  for (const match of text.matchAll(fence)) {
    const index = match.index ?? 0;
    if (index > last) {
      found.push(...plainPieces(text.slice(last, index)));
    }
    const body = match[2].replace(/\n$/, '');
    const lang = match[1] === 'json' || jsonText(body) ? 'json' : match[1] || 'code';
    found.push({ lang, body });
    last = index + match[0].length;
  }
  if (last < text.length) {
    found.push(...plainPieces(text.slice(last)));
  }
  return found.filter((piece) => piece.body.trim() !== '');
}

function plainPieces(text: string): { lang: string | null; body: string }[] {
  const lines = text.split('\n');
  const found: { lang: string | null; body: string }[] = [];
  let prose: string[] = [];
  const flush = (): void => {
    if (prose.length > 0) {
      found.push({ lang: null, body: prose.join('\n').trim() });
      prose = [];
    }
  };
  for (let index = 0; index < lines.length; index += 1) {
    const start = lines[index].trim();
    if (start !== '{' && start !== '[') {
      prose.push(lines[index]);
      continue;
    }
    let blob = '';
    let end = -1;
    for (let cursor = index; cursor < lines.length; cursor += 1) {
      blob = blob === '' ? lines[cursor] : `${blob}\n${lines[cursor]}`;
      if (jsonText(blob)) {
        end = cursor;
        break;
      }
    }
    if (end < 0) {
      prose.push(lines[index]);
      continue;
    }
    flush();
    found.push({ lang: 'json', body: lines.slice(index, end + 1).join('\n') });
    index = end;
  }
  flush();
  return found;
}

function jsonText(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    return Boolean(parsed) && typeof parsed === 'object';
  } catch {
    return false;
  }
}

function headerFill(type: string, theme: Theme): string {
  const palette = theme.vars?.palette;
  if (type === 'thinking') {
    return `rgba(${palette?.secondary.mainChannel} / 0.18)`;
  }
  if (type === 'assistant' || type === 'result') {
    return `rgba(${palette?.primary.mainChannel} / 0.18)`;
  }
  if (type === 'status') {
    return `rgba(${palette?.error.mainChannel} / 0.18)`;
  }
  if (type === 'connection' || type === 'retry') {
    return `rgba(${palette?.info.mainChannel} / 0.18)`;
  }
  return `rgba(${palette?.text.primaryChannel} / 0.06)`;
}

const codeSx = {
  m: 0,
  px: 1.25,
  py: 1,
  bgcolor: 'divider',
  color: 'text.primary',
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
  lineHeight: 1.55,
  whiteSpace: 'pre-wrap',
  overflow: 'auto',
};
