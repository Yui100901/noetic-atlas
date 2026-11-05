import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PDFDocument, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import type { ExportDocument } from '../../shared/models/export-types.js';
import { renderExportPdf, type PdfFormulaResolver } from '../../web/shared/export/export-pdf.js';

const font = readFile('web/assets/fonts/NotoSansSC-Regular.ttf');
const document = (markdown: string, mathEnabled = true): ExportDocument => ({
  version: 1,
  mathEnabled,
  mode: 'answers',
  title: '专业表达测试',
  description: '',
  filename: 'formula',
  paperId: 'p',
  paperVersion: 1,
  generatedAt: '2026-10-30T00:00:00.000Z',
  snapshotCreatedAt: '2026-10-30T00:00:00.000Z',
  scoring: { enabled: false, scheme: 'none', totalPoints: 0, questionPoints: {} },
  questions: [],
  markdown,
});
const png = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
    'base64',
  ),
);
const objects = (pdf: PDFDocument) =>
  pdf.context.enumerateIndirectObjects().map(([, object]) => object);
const images = (pdf: PDFDocument) =>
  objects(pdf).filter(
    (object) =>
      object instanceof PDFRawStream && object.dict.toString().includes('/Subtype /Image'),
  );
const textOperations = (pdf: PDFDocument) =>
  objects(pdf)
    .filter(
      (object): object is PDFRawStream =>
        object instanceof PDFRawStream && !object.dict.toString().includes('/Subtype /Image'),
    )
    .flatMap((object) => {
      try {
        return (
          Buffer.from(decodePDFRawStream(object).decode())
            .toString('latin1')
            .match(/\bTj\b/g) || []
        );
      } catch {
        return [];
      }
    }).length;

test('PDF reuses one embedded managed image across repeated question and answer appearances', async () => {
  const source = await font;
  const single = await PDFDocument.load(
    await renderExportPdf(
      document('![同一图片](/api/assets/sample/content)'),
      source,
      undefined,
      async () => ({ data: png, mimeType: 'image/png' }),
    ),
  );
  let calls = 0;
  const repeated = await PDFDocument.load(
    await renderExportPdf(
      document(
        Array.from({ length: 50 }, () => '![同一图片](/api/assets/sample/content)').join('\n\n'),
      ),
      source,
      undefined,
      async () => {
        calls++;
        return { data: png, mimeType: 'image/png' };
      },
    ),
  );
  assert.equal(calls, 1);
  assert.equal(
    images(repeated).length,
    images(single).length,
    'the same PDF image object is reused, not only its downloaded bytes',
  );
  assert.ok(repeated.getPageCount() > single.getPageCount());
});
test('PDF renders mixed inline/display/table math, reuses formulas and paginates tall content', async () => {
  const calls: string[] = [];
  const resolver: PdfFormulaResolver = async (source, display, size) => {
    calls.push(JSON.stringify([source, display, size]));
    return {
      data: png,
      mimeType: 'image/png',
      width: display ? 150 : 40,
      height: display ? 75 : 24,
      baseline: 18,
    };
  };
  const markdown =
    '# 专业表达 $x^2$\n\n' +
    Array.from({ length: 35 }, () => '正文与公式 $\\frac{1}{2}$ 同行，对齐和换行保留。\n').join(
      '\n',
    ) +
    '\n\n$$\n\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}\n$$\n\n| 符号 | 定义 |\n|---|---|\n| $\\alpha$ | 系数 |\n| $\\ce{H2O}$ | 水 |';
  const bytes = await renderExportPdf(
      document(markdown),
      await font,
      undefined,
      undefined,
      resolver,
    ),
    pdf = await PDFDocument.load(bytes);
  assert.ok(pdf.getPageCount() > 1);
  assert.ok(images(pdf).length >= 5);
  assert.ok(textOperations(pdf) > 30, 'prose remains PDF text');
  assert.equal(
    calls.filter((call) => call.includes('frac')).length,
    1,
    'repeated inline formulas are embedded once',
  );
  assert.ok(
    calls.some((call) => call.includes('ce')),
    'table formula must not be flattened into plain TeX',
  );
});
test('legacy dollars remain text and do not invoke a formula converter', async () => {
  let calls = 0;
  const bytes = await renderExportPdf(
      document('售价 $10，余额 $2。\n\n`$x$`', false),
      await font,
      undefined,
      undefined,
      async () => {
        calls++;
        throw new Error('should not render');
      },
    ),
    pdf = await PDFDocument.load(bytes);
  assert.equal(calls, 0);
  assert.equal(images(pdf).length, 0);
  assert.ok(textOperations(pdf) > 0);
});
test('conversion errors and unreasonably wide formulas retain visible fallback text', async () => {
  const bytes = await renderExportPdf(
      document('前文 $broken$ 后文。\n\n$$\nwide\n$$'),
      await font,
      undefined,
      undefined,
      async (source) => {
        if (source === 'broken') throw new Error('测试转换失败');
        return { data: png, mimeType: 'image/png', width: 4000, height: 40, baseline: 30 };
      },
    ),
    pdf = await PDFDocument.load(bytes);
  assert.equal(images(pdf).length, 0);
  assert.ok(textOperations(pdf) >= 6, 'both diagnostics and original sources must be written');
});
