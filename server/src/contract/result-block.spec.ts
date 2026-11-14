import { findResultBlock, parseResultBlock } from './result-block';

const fence = '```';
const block = (body: string): string => `${fence}json\n${body}\n${fence}`;

describe('result block', () => {
  it('reads a valid block after prose', () => {
    expect(parseResultBlock(`Done.\n\n${block('{"a": 1}')}`)).toEqual({ ok: true, value: { a: 1 } });
  });

  it('reports an answer with no block', () => {
    const parsed = parseResultBlock('Only prose.');
    expect(parsed).toEqual({ ok: false, error: expect.stringContaining('no result block') });
  });

  it('reports a block that is never closed', () => {
    expect(findResultBlock(`${fence}json\n{"a": 1}`)).toBeNull();
  });

  it('reports invalid JSON', () => {
    expect(parseResultBlock(block('{"a": '))).toEqual({ ok: false, error: expect.stringContaining('not valid JSON') });
  });

  it.each(['[1]', '"text"', 'null', '3'])('reports %s, which is not an object', (body) => {
    expect(parseResultBlock(block(body))).toEqual({ ok: false, error: expect.stringContaining('one JSON object') });
  });

  it('reads the last block when an earlier json example comes first', () => {
    const text = `Example:\n${block('{"example": true}')}\n\nResult:\n${block('{"real": true}')}`;
    expect(parseResultBlock(text)).toEqual({ ok: true, value: { real: true } });
  });

  it('ignores a prose line that only mentions the fence', () => {
    expect(findResultBlock(`Use a ${fence}json fence like this.\nbye`)).toBeNull();
  });

  it('keeps a multi-line object and tolerates carriage returns', () => {
    const text = `${fence}json\r\n{\r\n"a": "x"\r\n}\r\n${fence}\r\n`;
    expect(parseResultBlock(text)).toEqual({ ok: true, value: { a: 'x' } });
  });
});
