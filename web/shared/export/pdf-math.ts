import { rgb, type PDFDocument, type PDFPage, type PDFFont } from 'pdf-lib';
import type { PdfNode as Node, PdfFormulaResolver } from './pdf-types';
interface MathPdfContext {
  pdf: PDFDocument;
  font: PDFFont;
  enabled: boolean;
  layout: { page: PDFPage; y: number };
  pageSize: readonly [number, number];
  margin: number;
  top: number;
  bottom: number;
  ensure: (height: number) => void;
  gap: (amount?: number) => void;
  paragraph: (
    text: string,
    options?: { indent?: number; size?: number; code?: boolean; color?: ReturnType<typeof rgb> },
  ) => void;
  renderImage: (node: Node, indent: number) => Promise<void>;
  clean: (text: string) => string;
  charWidth: (char: string) => number;
  nodeText: (node: Node) => string;
  resolveFormula?: PdfFormulaResolver;
}
/** Optional formula layout shares the existing document cursor, page creation
 * and text sanitization. It never loads a browser renderer in the text path. */
export function createMathPdfRenderer(context: MathPdfContext) {
  const {
    pdf,
    font,
    enabled,
    layout,
    pageSize: PAGE,
    margin: MARGIN,
    top: TOP,
    bottom: BOTTOM,
    ensure,
    gap,
    paragraph,
    renderImage,
    clean,
    charWidth,
    nodeText,
    resolveFormula,
  } = context;
  const ink = rgb(0.15, 0.2, 0.23),
    muted = rgb(0.38, 0.44, 0.47);
  const isMath = (node: Node) =>
    node.type === 'inlineMath' ||
    node.type === 'math' ||
    (enabled && node.type === 'code' && node.lang === 'math');
  const containsMath = (node: Node): boolean =>
    !!isMath(node) || (node.children || []).some(containsMath);
  const formulaCache = new Map<
    string,
    Promise<{
      image: Awaited<ReturnType<PDFDocument['embedPng']>>;
      width: number;
      height: number;
      baseline: number;
    }>
  >();
  const formulaImage = (source: string, display: boolean, size: number) => {
    const key = JSON.stringify([source, display, size]);
    let promise = formulaCache.get(key);
    if (!promise) {
      promise = (async () => {
        if (!resolveFormula) throw new Error('公式图片转换不可用');
        const value = await resolveFormula(source, display, size);
        if (
          ![value.width, value.height, value.baseline].every(Number.isFinite) ||
          value.width <= 0 ||
          value.height <= 0 ||
          value.baseline < 0 ||
          value.baseline > value.height
        )
          throw new Error('公式图片尺寸无效');
        if (
          Math.min(
            1,
            (PAGE[0] - MARGIN * 2) / value.width,
            (PAGE[1] - TOP - BOTTOM - 20) / value.height,
          ) < 0.45
        )
          throw new Error('公式过宽或过高，请拆分后导出');
        return {
          image: await pdf.embedPng(value.data),
          width: value.width,
          height: value.height,
          baseline: value.baseline,
        };
      })();
      formulaCache.set(key, promise);
    }
    return promise;
  };
  const formulaFallback = (source: string, error: unknown, indent: number) => {
    paragraph(
      `公式未能嵌入：${error instanceof Error ? error.message : '转换失败'}；保留LaTeX源码如下。`,
      { indent, size: 9, color: muted },
    );
    paragraph(
      source.length > 8000 ? source.slice(0, 8000) + '…（已截断，请查看Markdown源文件）' : source,
      { indent, size: 9, code: true },
    );
  };
  const renderDisplayFormula = async (node: Node, indent: number) => {
    try {
      const value = await formulaImage(node.value || '', true, 11.5),
        available = PAGE[0] - MARGIN * 2 - indent,
        maxHeight = PAGE[1] - TOP - BOTTOM - 20,
        scale = Math.min(1, available / value.width, maxHeight / value.height);
      if (scale < 0.45) throw new Error('公式过宽或过高，请拆分后导出');
      const width = value.width * scale,
        height = value.height * scale;
      ensure(height + 16);
      gap(5);
      layout.page.drawImage(value.image, {
        x: MARGIN + indent + (available - width) / 2,
        y: layout.y - height,
        width,
        height,
      });
      layout.y -= height;
      gap(11);
    } catch (error) {
      formulaFallback(node.value || '', error, indent);
    }
  };
  /** Mixed line boxes keep text selectable and align a formula's measured
   * baseline. Every row reserves its real ascent/descent before page breaking. */
  const renderRichInline = async (node: Node, indent: number, prefix = '', size = 10.5) => {
    type Run = {
      text?: string;
      image?: Awaited<ReturnType<typeof formulaImage>>;
      width: number;
      ascent: number;
      descent: number;
      scale?: number;
    };
    const width = PAGE[0] - MARGIN * 2 - indent;
    let runs: Run[] = [],
      used = 0;
    const flush = () => {
      if (!runs.length) return;
      const ascent = Math.max(size, ...runs.map((r) => r.ascent)),
        descent = Math.max(size * 0.25, ...runs.map((r) => r.descent)),
        height = Math.max(size * 1.65, ascent + descent + 4);
      ensure(height);
      const baseline = layout.y - ascent - 2;
      let x = MARGIN + indent;
      for (const run of runs) {
        if (run.text) layout.page.drawText(run.text, { x, y: baseline, font, size, color: ink });
        else if (run.image) {
          const scale = run.scale || 1;
          layout.page.drawImage(run.image.image, {
            x,
            y: baseline - run.descent,
            width: run.width,
            height: run.image.height * scale,
          });
        }
        x += run.width;
      }
      layout.y -= height;
      runs = [];
      used = 0;
    };
    const text = (value: string) => {
      for (const char of Array.from(clean(value))) {
        if (char === '\n') {
          flush();
          continue;
        }
        const next = charWidth(char) * size;
        if (used + next > width) flush();
        if (!used && char === ' ') continue;
        const previous = runs.at(-1);
        if (previous?.text !== undefined) {
          previous.text += char;
          previous.width += next;
        } else runs.push({ text: char, width: next, ascent: size, descent: size * 0.25 });
        used += next;
      }
    };
    const walk = async (child: Node): Promise<void> => {
      if (isMath(child))
        try {
          const image = await formulaImage(child.value || '', false, size),
            scale = Math.min(1, width / image.width);
          if (scale < 0.45) throw new Error('行内公式过宽，请拆分后导出');
          const w = image.width * scale;
          if (used + w > width) flush();
          runs.push({
            image,
            width: w,
            ascent: image.baseline * scale,
            descent: (image.height - image.baseline) * scale,
            scale,
          });
          used += w;
        } catch (error) {
          flush();
          formulaFallback(child.value || '', error, indent);
        }
      else if (child.type === 'image') {
        flush();
        await renderImage(child, indent);
      } else if (child.type === 'link') {
        for (const part of child.children || []) await walk(part);
        if (child.url && child.url !== nodeText({ ...child, type: 'paragraph' }))
          text(` (${child.url})`);
      } else if (child.children) for (const part of child.children) await walk(part);
      else text(nodeText(child));
    };
    text(prefix);
    for (const child of node.children || []) await walk(child);
    flush();
    gap(5);
  };
  const reserveFormulaHeading = async (node: Node, indent: number) => {
    try {
      const value = await formulaImage(node.value || '', true, 11.5),
        scale = Math.min(
          1,
          (PAGE[0] - MARGIN * 2 - indent) / value.width,
          (PAGE[1] - TOP - BOTTOM - 20) / value.height,
        );
      ensure(Math.min(value.height * scale + 85, PAGE[1] - TOP - BOTTOM));
    } catch {
      ensure(115);
    }
  };
  return { isMath, containsMath, renderDisplayFormula, renderRichInline, reserveFormulaHeading };
}
