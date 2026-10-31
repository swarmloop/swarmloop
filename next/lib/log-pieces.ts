export function pieces(text: string): { lang: string | null; body: string }[] {
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

export function plainPieces(text: string): { lang: string | null; body: string }[] {
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

export function jsonText(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text);
    return Boolean(parsed) && typeof parsed === 'object';
  } catch {
    return false;
  }
}
