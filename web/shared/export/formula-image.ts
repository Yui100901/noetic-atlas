import { getFontEmbedCSS } from 'html-to-image';
import { renderFormula } from '../../../shared/math/engine';
import { base64ToBytes } from '../../../shared/assets/assets';
import type { PdfFormulaResolver } from './export-pdf';
import 'katex/dist/katex.min.css';
import katexCss from 'katex/dist/katex.min.css?inline';

const formulaCss =
  katexCss.replace(/@font-face\s*\{[^}]*\}/g, '') +
  '\n.katex{font-size:1.08em}.katex-display{margin:0}';
/** Keep the measured DOM and SVG in the same isolated CSS environment. Copying
 * computed font shorthands can change font metrics and clip reaction products. */
async function rasterFormula(
  formula: HTMLElement,
  fontCss: string,
  width: number,
  height: number,
): Promise<string> {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  const foreign = document.createElementNS(svg.namespaceURI, 'foreignObject');
  foreign.setAttribute('width', '100%');
  foreign.setAttribute('height', '100%');
  const content = document.createElementNS('http://www.w3.org/1999/xhtml', 'div'),
    style = document.createElementNS('http://www.w3.org/1999/xhtml', 'style');
  style.textContent = fontCss + '\n' + formulaCss;
  content.append(style, formula.cloneNode(true));
  foreign.append(content);
  svg.append(foreign);
  const image = new Image();
  image.src =
    'data:image/svg+xml;charset=utf-8,' +
    encodeURIComponent(new XMLSerializer().serializeToString(svg));
  await image.decode();
  const ratio = Math.min(3, Math.sqrt(12_000_000 / (width * height))),
    canvas = document.createElement('canvas');
  canvas.width = Math.ceil(width * ratio);
  canvas.height = Math.ceil(height * ratio);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('公式图片转换不可用');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/png');
}

/** One export owns a bounded cache; detached formula DOM is removed even when
 * font loading or rasterization fails. No remote converter or CDN is used. */
export function createPdfFormulaResolver(): PdfFormulaResolver {
  const cache = new Map<string, Awaited<ReturnType<PdfFormulaResolver>>>();
  let retainedBytes = 0;
  const fontCss = new Map<string, Promise<string>>();
  return async (source, display, size) => {
    const key = JSON.stringify([source, display, size]),
      cached = cache.get(key);
    if (cached) return cached;
    const result = renderFormula(source, display);
    if (!result.ok) throw new Error(result.message);
    const host = document.createElement('div');
    host.style.cssText = `position:fixed;left:-10000px;top:0;z-index:-1;display:block;width:max-content;white-space:nowrap;background:white;color:black;font-size:${size / 0.75}px;line-height:normal;`;
    const formula = document.createElement('span');
    formula.style.cssText = `display:inline-block;box-sizing:content-box;padding:6px;white-space:nowrap;background:white;color:black;font-family:KaTeX_Main,serif;font-weight:400;font-style:normal;font-synthesis:none;font-size:${size / 0.75}px;line-height:normal;letter-spacing:normal;`;
    formula.innerHTML = result.html;
    const marker = document.createElement('span');
    marker.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline;';
    if (!display) formula.append(marker);
    const shadow = host.attachShadow({ mode: 'closed' }),
      style = document.createElement('style');
    style.textContent = formulaCss;
    shadow.append(style, formula);
    document.body.append(host);
    try {
      // Read layout before waiting, so this formula's local font faces are requested.
      formula.getBoundingClientRect();
      await document.fonts.ready;
      const box = formula.getBoundingClientRect(),
        width = Math.ceil(box.width),
        height = Math.ceil(box.height);
      if (width < 1 || height < 1 || width > 7000 || height > 4000 || width * height > 4_000_000)
        throw new Error('公式尺寸过大，请拆分公式后导出');
      const baseline = display
        ? height * 0.8
        : Math.max(0, Math.min(height, marker.getBoundingClientRect().top - box.top));
      const fontKey = [
        ...new Set(
          [formula, ...formula.querySelectorAll('*')]
            .filter((node) => node instanceof HTMLElement)
            .map((node) => getComputedStyle(node).fontFamily),
        ),
      ]
        .sort()
        .join('|');
      // Do not set preferredFontFormat: the upstream stateful URL regex can
      // silently discard alternate font-face sources, including normal weight.
      let fontRequest = fontCss.get(fontKey);
      if (!fontRequest) {
        fontRequest = getFontEmbedCSS(formula);
        fontCss.set(fontKey, fontRequest);
        if (fontCss.size > 8) fontCss.delete(fontCss.keys().next().value!);
      }
      const url = await rasterFormula(formula, await fontRequest, width, height);
      const image = {
        data: base64ToBytes(url.slice(url.indexOf(',') + 1)),
        mimeType: 'image/png',
        width: width * 0.75,
        height: height * 0.75,
        baseline: baseline * 0.75,
      };
      if (image.data.length < 8_000_000) {
        cache.set(key, image);
        retainedBytes += image.data.length;
        while (cache.size > 128 || retainedBytes > 16_000_000) {
          const first = cache.entries().next().value!;
          cache.delete(first[0]);
          retainedBytes -= first[1].data.length;
        }
      }
      return image;
    } finally {
      host.remove();
    }
  };
}
