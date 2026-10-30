import test from 'node:test';
import assert from 'node:assert/strict';
import { documentTextBlocks } from '../../shared/questions/document-blocks.js';
import {
  documentSourceHref,
  sourceLocation,
} from '../../web/features/library/source-navigation.js';
import { contentReturn } from '../../web/shared/lib/content-navigation.js';
import {
  safeLibraryReturn,
  libraryQuestionHref,
} from '../../web/features/questions/library-navigation.js';
import { documentFilesDraft } from '../../web/features/ai/ai-document-draft-state.js';

test('Markdown paragraph identities preserve exact UTF16 and fenced code boundaries', () => {
  const text =
    '# 变量\r\n\r\n变量🙂对应值。\r\n\r\n```js\nconst x=1;\n\nconsole.log(x);\n```\n\n末段。';
  const blocks = documentTextBlocks(text);
  assert.equal(blocks.length, 4);
  assert.ok(text.slice(blocks[2].start, blocks[2].end).includes('const x=1;\n\nconsole.log(x)'));
  assert.equal(blocks.map((b) => text.slice(b.start, b.end)).join(''), text);
});
test('source links preserve reading context and reject external returns and invalid offsets', () => {
  const citation = {
    documentId: '教材',
    versionId: 'a'.repeat(64),
    title: '教材',
    relation: 'reference' as const,
    label: '',
    excerpt: '',
    startOffset: 0,
    endOffset: 12,
  };
  const back = '#/papers/SET/questions/Q?partId=one',
    href = documentSourceHref(citation, back),
    params = new URLSearchParams(href.split('?')[1]);
  assert.equal(params.get('returnTo'), back);
  assert.deepEqual(sourceLocation(params), { range: { start: 0, end: 12 }, page: 1 });
  assert.equal(
    new URLSearchParams(documentSourceHref(citation, 'https://evil.test').split('?')[1]).get(
      'returnTo',
    ),
    '#/documents',
  );
  for (const value of [
    'javascript:alert(1)',
    '#/attempts/exam',
    'https://evil.test',
    '#//documents',
  ])
    assert.equal(contentReturn(value), '#/documents');
  assert.equal(safeLibraryReturn(href), href);
  assert.equal(
    new URLSearchParams(libraryQuestionHref('Q', href).split('?')[1]).get('returnTo'),
    href,
  );
  assert.equal(sourceLocation(new URLSearchParams('start=NaN&end=4&page=-2')).range, undefined);
  assert.equal(sourceLocation(new URLSearchParams('page=0')).page, 1);
});
test('AI source selection survives saved workspace draft round trips', () => {
  const sourceCitation = {
    documentId: 'book',
    versionId: 'a'.repeat(64),
    title: '教材',
    relation: 'summarized',
    label: '段落块1',
    excerpt: '文字',
    startOffset: 0,
    endOffset: 2,
  };
  const value = {
    sections: [{ text: '文字', sourceCitation }],
    sourceName: '教材',
    characters: 2,
    bytes: 6,
    files: 1,
    pages: 0,
    warnings: [],
  };
  assert.deepEqual(documentFilesDraft(value), value);
});
