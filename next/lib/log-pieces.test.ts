import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { jsonText, pieces, plainPieces } from './log-pieces.ts';

describe('jsonText', () => {
  it('accepts objects and arrays and rejects other json', () => {
    assert.equal(jsonText('{"a":1}'), true);
    assert.equal(jsonText('[1]'), true);
    assert.equal(jsonText('null'), false);
    assert.equal(jsonText('1'), false);
    assert.equal(jsonText('"a"'), false);
    assert.equal(jsonText('nope'), false);
  });
});

describe('pieces', () => {
  it('splits fences and leaves the language, treating json bodies as json', () => {
    assert.deepEqual(pieces('hello'), [{ lang: null, body: 'hello' }]);
    assert.deepEqual(pieces('  hi  \n'), [{ lang: null, body: 'hi' }]);
    assert.deepEqual(pieces('before\n```ts\nconst a = 1\n```\nafter'), [
      { lang: null, body: 'before' },
      { lang: 'ts', body: 'const a = 1' },
      { lang: null, body: 'after' },
    ]);
    assert.deepEqual(pieces('```\nconst a = 1\n```'), [{ lang: 'code', body: 'const a = 1' }]);
    assert.deepEqual(pieces('```\n{"a":1}\n```'), [{ lang: 'json', body: '{"a":1}' }]);
    assert.deepEqual(pieces('```json\n{"a":1}\n```'), [{ lang: 'json', body: '{"a":1}' }]);
    assert.deepEqual(pieces('```\n\n```'), []);
    assert.deepEqual(pieces('```js\ncode'), [{ lang: null, body: '```js\ncode' }]);
  });

  it('lifts a bare json value out of the prose', () => {
    assert.deepEqual(pieces('see\n{\n  "a": 1\n}\ndone'), [
      { lang: null, body: 'see' },
      { lang: 'json', body: '{\n  "a": 1\n}' },
      { lang: null, body: 'done' },
    ]);
    assert.deepEqual(pieces('{ not json'), [{ lang: null, body: '{ not json' }]);
    assert.deepEqual(plainPieces('[\n1\n]'), [{ lang: 'json', body: '[\n1\n]' }]);
  });
});
