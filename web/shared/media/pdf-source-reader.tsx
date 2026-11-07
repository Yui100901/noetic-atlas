import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { useAssetObjectUrl } from './asset-render';
import { ErrorNotice, Loading } from '../ui/components';
import { pdfMatchingItems } from '../../../shared/pdf/text';

/** One page at a time on both browser and Android; no external PDF reader is
 * needed to follow a citation. Source text is never executed as HTML. */
export function PdfSourceReader({
  assetId,
  initialPage = 1,
  onPage,
  targetPage,
  searchQuery = '',
}: {
  assetId: string;
  initialPage?: number;
  onPage?: (page: number) => void;
  targetPage?: number;
  searchQuery?: string;
}) {
  const file = useAssetObjectUrl(assetId),
    canvas = useRef<HTMLCanvasElement>(null),
    container = useRef<HTMLDivElement>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null),
    [page, setPage] = useState(initialPage),
    [width, setWidth] = useState(800),
    [error, setError] = useState(''),
    [rendering, setRendering] = useState(true);
  const [draftPage, setDraftPage] = useState(String(initialPage));
  const [highlights, setHighlights] = useState<
    Array<{ left: number; top: number; width: number; height: number }>
  >([]);
  useEffect(() => {
    if (targetPage && pdf) setPage(Math.min(targetPage, pdf.numPages));
  }, [targetPage, pdf]);
  useEffect(() => {
    const parent = container.current;
    if (!parent) return;
    const observer = new ResizeObserver((entries) =>
      setWidth(Math.max(1, Math.min(1200, entries[0].contentRect.width))),
    );
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let active = true;
    let task: { destroy: () => Promise<void> } | undefined;
    setPdf(null);
    setRendering(true);
    setError('');
    if (file.url)
      void (async () => {
        try {
          const pdfjs = await import('pdfjs-dist'),
            worker = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
          pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
          const base = new URL(import.meta.env.BASE_URL, document.baseURI);
          const load = pdfjs.getDocument({
            url: file.url,
            useSystemFonts: true,
            cMapPacked: true,
            cMapUrl: new URL('pdfjs/cmaps/', base).href,
            standardFontDataUrl: new URL('pdfjs/standard_fonts/', base).href,
          });
          task = load;
          if (!active) {
            await load.destroy();
            return;
          }
          const loaded = await load.promise;
          if (active) {
            setPdf(loaded);
            setPage(Math.min(initialPage, loaded.numPages));
            if (initialPage > loaded.numPages)
              setError(
                `引用页码${initialPage}超出文件的${loaded.numPages}页，已显示末页，请核对引用。`,
              );
          }
        } catch (reason) {
          if (active) setError((reason as Error).message);
        }
      })();
    return () => {
      active = false;
      void task?.destroy();
    };
  }, [file.url, initialPage]);
  useEffect(() => {
    setDraftPage(String(page));
    onPage?.(page);
  }, [page, onPage]);
  useEffect(() => {
    if (!pdf || !canvas.current) return;
    let active = true;
    let render: { cancel: () => void } | undefined;
    setRendering(true);
    void (async () => {
      try {
        const source = await pdf.getPage(page);
        if (!active) return;
        const natural = source.getViewport({ scale: 1 }),
          dpr = Math.min(window.devicePixelRatio || 1, 2),
          viewport = source.getViewport({ scale: (width / natural.width) * dpr });
        const element = canvas.current!;
        element.width = viewport.width;
        element.height = viewport.height;
        element.style.width = `${width}px`;
        const task = source.render({ canvas: element, viewport });
        render = task;
        await task.promise;
        if (active) {
          const content = searchQuery ? await source.getTextContent() : null,
            items = content?.items.filter((item) => 'str' in item) || [],
            found = pdfMatchingItems(
              items.map((item) => ({ text: 'str' in item ? item.str : '' })),
              searchQuery,
            ),
            boxes: Array<{ left: number; top: number; width: number; height: number }> = [];
          items.forEach((item, index) => {
            if (!found.has(index) || !('str' in item)) return;
            const [, , , , x, y] = item.transform,
              h = item.height || Math.hypot(item.transform[2]!, item.transform[3]!),
              rect = [
                ...viewport.convertToViewportPoint(x!, y! - h * 0.15),
                ...viewport.convertToViewportPoint(x! + item.width, y! + h * 0.85),
              ],
              left = Math.max(0, Math.min(rect[0]!, rect[2]!) / dpr),
              top = Math.max(0, Math.min(rect[1]!, rect[3]!) / dpr),
              right = Math.min(viewport.width / dpr, Math.max(rect[0]!, rect[2]!) / dpr),
              bottom = Math.min(viewport.height / dpr, Math.max(rect[1]!, rect[3]!) / dpr);
            if (right > left && bottom > top)
              boxes.push({ left, top, width: right - left, height: bottom - top });
          });
          setHighlights(boxes);
        }
      } catch (reason) {
        if (active && (reason as Error).name !== 'RenderingCancelledException')
          setError((reason as Error).message);
      } finally {
        if (active) setRendering(false);
      }
    })();
    return () => {
      active = false;
      render?.cancel();
    };
  }, [pdf, page, width, searchQuery]);
  return (
    <section aria-label="PDF原文阅读器">
      <div className="source-pdf-toolbar">
        <button
          type="button"
          className="button"
          disabled={!pdf || page <= 1}
          onClick={() => setPage((value) => value - 1)}
        >
          <ChevronLeft size={16} />
          上一页
        </button>
        <label>
          文件页{' '}
          <input
            aria-label="PDF文件页码"
            type="number"
            min={1}
            max={pdf?.numPages || 100000}
            value={draftPage}
            onChange={(event) => setDraftPage(event.target.value)}
            onBlur={() => {
              const number = Number(draftPage);
              setPage(
                Number.isInteger(number) && number > 0
                  ? Math.min(number, pdf?.numPages || 1)
                  : page,
              );
              setDraftPage(
                String(
                  Number.isInteger(number) && number > 0
                    ? Math.min(number, pdf?.numPages || 1)
                    : page,
                ),
              );
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur();
            }}
          />{' '}
          / {pdf?.numPages || '…'}
        </label>
        <button
          type="button"
          className="button"
          disabled={!pdf || page >= pdf.numPages}
          onClick={() => setPage((value) => value + 1)}
        >
          下一页
          <ChevronRight size={16} />
        </button>
      </div>
      {(error || file.error) && <ErrorNotice message={error || file.error} />}
      <div ref={container} className="source-pdf-canvas">
        {!pdf && !error && !file.error && <Loading text="正在读取原文PDF…" />}
        <div className="pdf-highlight-stage" style={{ width, margin: '0 auto' }}>
          <canvas ref={canvas} aria-label={`PDF文件第${page}页`} aria-busy={rendering} />
          {!rendering &&
            highlights.map((box, index) => (
              <span key={index} className="pdf-text-highlight" style={box} aria-hidden="true" />
            ))}
        </div>
      </div>
    </section>
  );
}
