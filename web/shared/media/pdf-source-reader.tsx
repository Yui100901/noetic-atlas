import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { useAssetObjectUrl } from './asset-render';
import { ErrorNotice, Loading } from '../ui/components';

/** One page at a time on both browser and Android; no external PDF reader is
 * needed to follow a citation. Source text is never executed as HTML. */
export function PdfSourceReader({
  assetId,
  initialPage = 1,
  onPage,
}: {
  assetId: string;
  initialPage?: number;
  onPage?: (page: number) => void;
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
  useEffect(() => {
    const parent = container.current;
    if (!parent) return;
    const observer = new ResizeObserver((entries) =>
      setWidth(Math.max(200, Math.min(1200, entries[0].contentRect.width))),
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
  }, [pdf, page, width]);
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
        <canvas ref={canvas} aria-label={`PDF文件第${page}页`} aria-busy={rendering} />
      </div>
    </section>
  );
}
