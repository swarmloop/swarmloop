interface AdfNode {
  type?: string;
  text?: string;
  content?: AdfNode[];
  marks?: { type?: string; attrs?: { href?: string } }[];
  attrs?: { level?: number; language?: string; url?: string; text?: string; id?: string };
}

export function adfToMarkdown(node: unknown): string {
  if (!node || typeof node !== 'object') {
    return '';
  }
  const current = node as AdfNode;
  switch (current.type) {
    case 'doc':
      return (current.content ?? []).map((child) => adfToMarkdown(child)).filter(Boolean).join('\n\n').trim();
    case 'paragraph':
      return inline(current);
    case 'heading':
      return `${'#'.repeat(current.attrs?.level ?? 1)} ${inline(current)}`.trim();
    case 'bulletList':
      return (current.content ?? []).map((child) => `- ${adfToMarkdown(child).replace(/\n/g, '\n  ')}`).join('\n');
    case 'orderedList':
      return (current.content ?? []).map((child, index) => `${index + 1}. ${adfToMarkdown(child)}`).join('\n');
    case 'listItem':
    case 'blockquote':
    case 'panel':
      return (current.content ?? []).map((child) => adfToMarkdown(child)).join('\n');
    case 'codeBlock':
      return `\`\`\`${current.attrs?.language ?? ''}\n${inline(current)}\n\`\`\``;
    case 'text':
      return applyMarks(current.text ?? '', current.marks);
    case 'hardBreak':
      return '\n';
    case 'mention':
      return `@${current.attrs?.text ?? current.attrs?.id ?? ''}`.trim();
    case 'inlineCard':
    case 'blockCard':
      return current.attrs?.url ?? '';
    default:
      return (current.content ?? []).map((child) => adfToMarkdown(child)).filter(Boolean).join('\n');
  }
}

export function collectUrls(node: unknown, into: Set<string>): void {
  if (!node || typeof node !== 'object') {
    return;
  }
  const current = node as AdfNode;
  const hrefs = (current.marks ?? []).map((mark) => mark.attrs?.href).filter((href): href is string => Boolean(href));
  for (const href of hrefs) {
    into.add(href);
  }
  if (current.attrs?.url) {
    into.add(current.attrs.url);
  }
  if (current.text) {
    for (const match of current.text.matchAll(/https?:\/\/[^\s)\]"'<>]+/g)) {
      into.add(match[0].replace(/[.,]$/, ''));
    }
  }
  for (const child of current.content ?? []) {
    collectUrls(child, into);
  }
}

function inline(node: AdfNode): string {
  return (node.content ?? []).map((child) => adfToMarkdown(child)).join('');
}

function applyMarks(text: string, marks: AdfNode['marks']): string {
  let value = text;
  for (const mark of marks ?? []) {
    if (mark.type === 'link' && mark.attrs?.href) {
      value = `[${value}](${mark.attrs.href})`;
    }
    if (mark.type === 'code') {
      value = `\`${value}\``;
    }
    if (mark.type === 'strong') {
      value = `**${value}**`;
    }
    if (mark.type === 'em') {
      value = `*${value}*`;
    }
  }
  return value;
}
