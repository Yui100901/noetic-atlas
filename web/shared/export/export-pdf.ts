import { PDFDocument, rgb, type PDFPage, type PDFFont } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { ExportDocument } from '../../../shared/models/export-types';
import { exportModeLabels } from '../../../shared/models/export-types';

type Node = { type: string; value?: string; depth?: number; ordered?: boolean; start?: number; checked?: boolean; url?: string; alt?: string; identifier?: string; children?: Node[] };
export interface PdfImageData { data: Uint8Array; mimeType: string }
export type PdfImageResolver = (url: string) => Promise<PdfImageData | null>;
const PAGE = [595.28, 841.89] as const;
const MARGIN = 46, TOP = 64, BOTTOM = 54;
const ink = rgb(.15, .20, .23), muted = rgb(.38, .44, .47), accent = rgb(.08, .34, .32);
const shade = rgb(.95, .97, .97), lineColor = rgb(.80, .85, .85);

function nodeText(node: Node): string {
  if (node.type === 'image') return `[图片：${node.alt || '无文字说明'}]`;
  if (node.type === 'break') return '\n';
  if (node.type === 'link') { const label = (node.children || []).map(nodeText).join(''); return node.url && node.url !== label ? `${label} (${node.url})` : label; }
  return node.value ?? (node.children || []).map(nodeText).join('');
}

/** Selectable Chinese text and managed raster images, with no remote requests. */
export async function renderExportPdf(document: ExportDocument, fontBytes: Uint8Array | ArrayBuffer, _reservedOptions?: unknown, resolveImage?: PdfImageResolver): Promise<Uint8Array> {
  const pdf = await PDFDocument.create(); pdf.registerFontkit(fontkit);
  // Keep the full TrueType font: fontkit's CJK subset output can map to missing
  // glyphs in standard PDF readers even when text extraction succeeds.
  const font = await pdf.embedFont(fontBytes, { subset: false });
  pdf.setTitle(`${document.title} - ${exportModeLabels[document.mode]}`); pdf.setAuthor('认知星图'); pdf.setCreator('认知星图 · 离线 PDF 导出');
  const supported = new Set(font.getCharacterSet());
  const clean = (text: string) => Array.from(text.replace(/\t/g, '    ').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')).map(char => char === '\n' || char === '\r' || supported.has(char.codePointAt(0)!) ? char : `[U+${char.codePointAt(0)!.toString(16).toUpperCase()}]`).join('').replace(/\r\n?/g, '\n');
  const cache = new Map<string, number>();
  const charWidth = (char: string) => { let n = cache.get(char); if (n === undefined) { n = font.widthOfTextAtSize(char, 1); cache.set(char, n); } return n; };
  const wrap = (raw: string, size: number, width: number): string[] => {
    const result: string[] = [];
    for (const hardLine of clean(raw).split('\n')) {
      if (!hardLine) { result.push(''); continue; }
      let buffer = '', measured = 0;
      for (const char of Array.from(hardLine)) {
        const next = charWidth(char) * size;
        if (measured + next > width && buffer) {
          // Prefer a word boundary for prose; fall back to glyph boundaries for long URLs/code/CJK.
          const space = buffer.lastIndexOf(' ');
          if (space > buffer.length * .55) { result.push(buffer.slice(0, space)); buffer = buffer.slice(space + 1); measured = font.widthOfTextAtSize(buffer, size); }
          else { result.push(buffer); buffer = ''; measured = 0; }
        }
        buffer += char; measured += next;
      }
      result.push(buffer);
    }
    return result;
  };
  let page: PDFPage; let y = 0;
  const newPage = () => {
    page = pdf.addPage([PAGE[0], PAGE[1]]); y = PAGE[1] - TOP;
    page.drawText('认知星图 / PRACTICE', { x: MARGIN, y: PAGE[1] - 32, font, size: 8, color: accent });
    const mode = exportModeLabels[document.mode]; page.drawText(mode, { x: PAGE[0] - MARGIN - font.widthOfTextAtSize(mode, 8), y: PAGE[1] - 32, font, size: 8, color: muted });
    page.drawLine({ start: { x: MARGIN, y: PAGE[1] - 42 }, end: { x: PAGE[0] - MARGIN, y: PAGE[1] - 42 }, color: lineColor, thickness: .6 });
  };
  newPage();
  const ensure = (height: number) => { if (y - height < BOTTOM) newPage(); };
  const gap = (amount = 7) => { y -= amount; };
  const drawLine = (text: string, size: number, x: number, width: number, options: { code?: boolean; color?: ReturnType<typeof rgb>; background?: boolean } = {}) => {
    const height = size * 1.65; ensure(height);
    if (options.background || options.code) page.drawRectangle({ x: x - 5, y: y - height + 4, width: width + 10, height, color: shade });
    if (text) page.drawText(text, { x, y: y - size, size, font, color: options.color || ink });
    y -= height;
  };
  const paragraph = (text: string, options: { size?: number; indent?: number; code?: boolean; color?: ReturnType<typeof rgb>; prefix?: string } = {}) => {
    const size = options.size || 10.5; const indent = Math.min(options.indent || 0, 120); const x = MARGIN + indent; const width = PAGE[0] - MARGIN * 2 - indent;
    for (const line of wrap((options.prefix || '') + text, size, width - (options.code ? 10 : 0))) drawLine(line, size, options.code ? x + 5 : x, options.code ? width - 10 : width, options);
    gap(options.code ? 9 : 5);
  };
  const table = (node: Node, indent: number) => {
    const rows = (node.children || []).map(row => (row.children || []).map(nodeText));
    if (!rows.length) return;
    const columns = Math.max(...rows.map(row => row.length));
    // Wide tables become labelled records to retain legible text on an A4 page.
    if (columns > 5) {
      const headers = rows[0]!;
      for (const row of rows.slice(1)) { for (let index = 0; index < row.length; index++) paragraph(`${headers[index] || `列 ${index + 1}`}：${row[index]}`, { indent: indent + 8, size: 9.5 }); gap(5); }
      return;
    }
    const x = MARGIN + indent; const width = PAGE[0] - MARGIN * 2 - indent; const colWidth = width / columns; const size = 9; const leading = 14.5;
    const prepared = rows.map(row => Array.from({ length: columns }, (_, index) => wrap(row[index] || '', size, colWidth - 14)));
    const drawChunk = (cells: string[][], start: number, count: number, header: boolean) => {
      const height = count * leading + 10;
      ensure(height);
      page.drawRectangle({ x, y: y - height, width, height, color: header ? shade : rgb(1, 1, 1), borderColor: lineColor, borderWidth: .5 });
      for (let col = 0; col < columns; col++) {
        if (col) page.drawLine({ start: { x: x + col * colWidth, y }, end: { x: x + col * colWidth, y: y - height }, thickness: .4, color: lineColor });
        for (let line = 0; line < count; line++) { const text = cells[col]?.[start + line]; if (text) page.drawText(text, { x: x + col * colWidth + 7, y: y - 7 - size - line * leading, font, size, color: header ? accent : ink }); }
      }
      y -= height;
    };
    for (let row = 0; row < prepared.length; row++) {
      const cells = prepared[row]!; const length = Math.max(...cells.map(cell => cell.length)); let offset = 0;
      while (offset < length) {
        let available = Math.floor((y - BOTTOM - 10) / leading);
        if (available < 1) {
          newPage();
          const header = prepared[0]!; const headerHeight = Math.max(...header.map(cell => cell.length));
          if (row > 0 && headerHeight < 8) drawChunk(header, 0, headerHeight, true);
          available = Math.floor((y - BOTTOM - 10) / leading);
        }
        const count = Math.min(available, length - offset); drawChunk(cells, offset, count, row === 0); offset += count;
      }
    }
    gap(10);
  };
  const imageCache = new Map<string, Promise<PdfImageData | null>>();
  const renderImage = async (node: Node, indent = 0) => {
    const url = node.url || ''; let image: Awaited<ReturnType<PDFDocument['embedPng']>> | null = null; let reason = '该图片不是可导出的本地图片';
    try {
      if (resolveImage) {
        let request = imageCache.get(url); if (!request) { request = resolveImage(url); imageCache.set(url, request); }
        const source = await request;
        if (source?.mimeType === 'image/png') image = await pdf.embedPng(source.data);
        else if (source?.mimeType === 'image/jpeg') image = await pdf.embedJpg(source.data);
        else if (source) reason = '此格式无法转换为 PNG 或 JPEG';
      }
    } catch { reason = '图片读取或转换失败'; }
    if (!image) { paragraph(`[图片未嵌入：${node.alt || '无文字说明'}；${reason}]`, { indent, color: muted, size: 9 }); return; }
    const maxWidth = PAGE[0] - MARGIN * 2 - indent, maxHeight = PAGE[1] - TOP - BOTTOM - 40;
    const scale = Math.min(1, maxWidth / image.width, maxHeight / image.height), width = image.width * scale, height = image.height * scale;
    ensure(height + (node.alt ? 30 : 12)); gap(4);
    page.drawImage(image, { x: MARGIN + indent + (maxWidth - width) / 2, y: y - height, width, height }); y -= height; gap(6);
    if (node.alt) paragraph(node.alt, { indent, color: muted, size: 9 });
  };
  // Preserve images embedded in emphasis, links, and list paragraphs in reading order.
  const renderInline = async (node: Node, indent: number, prefix = '') => {
    let text = prefix;
    const flush = () => { if (text.trim()) paragraph(text, { indent }); text = ''; };
    const walk = async (child: Node): Promise<void> => {
      if (child.type === 'image') { flush(); await renderImage(child, indent); }
      else if (child.type === 'link' && !(child.children || []).some(part => part.type === 'image')) text += nodeText(child);
      else if (child.children) for (const part of child.children) await walk(part);
      else text += nodeText(child);
    };
    for (const child of node.children || []) await walk(child); flush();
  };
  const renderNode = async (node: Node, indent = 0): Promise<void> => {
    if (node.type === 'heading') {
      const depth = node.depth || 1; const size = depth === 1 ? 21 : depth === 2 ? 14 : 11;
      const lines = wrap(nodeText(node), size, PAGE[0] - MARGIN * 2 - indent);
      // Question headings need room for metadata and the beginning of the stem.
      ensure(Math.min(lines.length * size * 1.65 + (depth === 2 ? 80 : 32), PAGE[1] - TOP - BOTTOM)); gap(depth <= 2 ? 9 : 4);
      for (const line of lines) drawLine(line, size, MARGIN + indent, PAGE[0] - MARGIN * 2 - indent, { color: depth <= 2 ? accent : ink });
      gap(5); return;
    }
    if (node.type === 'paragraph') { await renderInline(node, indent); return; }
    if (node.type === 'image') { await renderImage(node, indent); return; }
    if (node.type === 'code') { paragraph(node.value || '', { indent: Math.min(indent + 6, 120), size: 8.7, code: true }); return; }
    if (node.type === 'table') {
      table(node, Math.min(indent, 120));
      const walk = async (part: Node): Promise<void> => { if (part.type === 'image') await renderImage(part, indent); else for (const child of part.children || []) await walk(child); };
      await walk(node); return;
    }
    if (node.type === 'thematicBreak') { ensure(26); gap(7); page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE[0] - MARGIN, y }, color: lineColor, thickness: .7 }); gap(12); return; }
    if (node.type === 'blockquote') { for (const child of node.children || []) await renderNode(child, Math.min(indent + 14, 120)); gap(4); return; }
    if (node.type === 'list') {
      for (let index = 0; index < (node.children || []).length; index++) {
        const item = node.children![index]!; const prefix = typeof item.checked === 'boolean' ? item.checked ? '[x] ' : '[ ] ' : node.ordered ? `${(node.start || 1) + index}. ` : '• ';
        let first = true;
        for (const child of item.children || []) { if (first && child.type === 'paragraph') await renderInline(child, Math.min(indent + 10, 120), prefix); else await renderNode(child, Math.min(indent + 20, 120)); first = false; }
      }
      return;
    }
    // HTML is deliberately not executed. Its text is retained for offline documents.
    if (node.type === 'html') { const text = (node.value || '').replace(/<[^>]+>/g, ''); if (text.trim()) paragraph(text, { indent }); return; }
    for (const child of node.children || []) await renderNode(child, indent);
  };
  const tree = unified().use(remarkParse).use(remarkGfm).parse(document.markdown) as unknown as Node;
  const definitions = new Map<string, string>();
  const collectDefinitions = (node: Node) => { if (node.type === 'definition' && node.identifier && node.url) definitions.set(node.identifier.toLowerCase(), node.url); for (const child of node.children || []) collectDefinitions(child); };
  collectDefinitions(tree);
  const resolveReferences = (node: Node) => {
    if (node.type === 'imageReference') { node.type = 'image'; node.url = definitions.get((node.identifier || '').toLowerCase()) || ''; }
    else if (node.type === 'linkReference') { node.type = 'link'; node.url = definitions.get((node.identifier || '').toLowerCase()) || ''; }
    for (const child of node.children || []) resolveReferences(child);
  };
  resolveReferences(tree);
  await renderNode(tree);
  const pages = pdf.getPages();
  pages.forEach((current, index) => {
    const title = wrap(document.title, 7.5, 350)[0] || '';
    current.drawLine({ start: { x: MARGIN, y: 39 }, end: { x: PAGE[0] - MARGIN, y: 39 }, color: lineColor, thickness: .5 });
    current.drawText(title, { x: MARGIN, y: 26, font, size: 7.5, color: muted });
    const number = `${index + 1} / ${pages.length}`; current.drawText(number, { x: PAGE[0] - MARGIN - font.widthOfTextAtSize(number, 8), y: 26, font, size: 8, color: muted });
  });
  return pdf.save();
}
