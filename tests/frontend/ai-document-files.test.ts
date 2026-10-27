import test from 'node:test';
import assert from 'node:assert/strict';
import { AI_DOCUMENT_LIMITS } from '../../shared/ai/ai-document.js';
import { documentPageRange, extractDocumentFiles, splitDocumentText } from '../../web/features/ai/ai-document-files.js';

test('document chunks preserve source code, whitespace, operators and complete Unicode while obeying model budgets', () => {
  const source = 'x'.repeat(11_999) + '😀\n' + '    if a != b:\n        print("日本語 中文 😀")\n'.repeat(900);
  const chunks = splitDocumentText(source);
  assert.ok(chunks.length > 1); assert.equal(chunks.join(''), source);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= AI_DOCUMENT_LIMITS.blockCharacters);
    assert.ok(new TextEncoder().encode(chunk).byteLength <= AI_DOCUMENT_LIMITS.blockBytes);
    assert.doesNotMatch(chunk, /^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u);
  }
  assert.match(chunks.join(''), /    if a != b:\n        print/);
});

test('document PDF page ranges accept complete and selected books but reject invalid bounds', () => {
  assert.deepEqual(documentPageRange(244), { first: 1, last: 244 });
  assert.deepEqual(documentPageRange(244, 31, 35), { first: 31, last: 35 });
  for (const [first, last] of [[0, 4], [6, 5], [1, 245], [1.5, 4], [1, Number.NaN]]) assert.throws(() => documentPageRange(244, first, last), /页码范围无效/);
});

test('multi-file text extraction keeps provenance and exact source material locally with progress', async () => {
  const content = '# Variables\n    total = 1 + 2 * 3\n' + '赋值与表达式。'.repeat(2000);
  const progress: string[] = [], second = 'A transaction commits or rolls back.';
  const result = await extractDocumentFiles([new File([content], 'program.md'), new File([second], 'chapter.txt')], { onProgress: update => progress.push(update.filename) });
  assert.equal(result.files, 2); assert.equal(result.pages, 0); assert.equal(result.sections.filter(section => section.sourceName === 'program.md').map(section => section.text).join(''), content);
  assert.equal(result.sections.at(-1)?.sourceName, 'chapter.txt'); assert.equal(result.characters, content.length + second.length);
  assert.deepEqual(progress, ['program.md', 'chapter.txt']); assert.match(result.sourceName, /等2份资料/);
});

test('local multi-file extraction fails without submitting partial inputs for invalid or oversized content and cancellation', async () => {
  await assert.rejects(extractDocumentFiles([new File([new Uint8Array([0xc3, 0x28])], 'bad.txt')]), /UTF-8/);
  await assert.rejects(extractDocumentFiles([new File(['a\0b'], 'binary.txt')]), /有效文本/);
  await assert.rejects(extractDocumentFiles([new File(['x'.repeat(AI_DOCUMENT_LIMITS.maxSourceCharacters + 1)], 'large.md')]), /400万字符/);
  await assert.rejects(extractDocumentFiles(Array.from({ length: 21 }, () => new File(['a'], 'a.txt'))), /1至20/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(extractDocumentFiles([new File(['a'], 'a.txt')], { signal: controller.signal }), { name: 'AbortError' });
});
