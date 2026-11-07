import { useEffect } from 'react';
import type { PdfJob } from '../../../shared/pdf/text';
import { decodeAsset, fetchAsset } from '../../shared/media/asset-files';
import { idPath, request, send } from '../../shared/lib/api';
export const wakePdfIndexer = () => window.dispatchEvent(new Event('atlas-pdf-jobs'));
/** PDF.js works in its worker. Only the open, visible application owns a lease;
 * closed browsers and background Android views do not claim to keep working. */
export function PdfIndexRunner() {
  useEffect(() => {
    let stopped = false,
      working = false,
      controller: AbortController | undefined,
      current: PdfJob | undefined;
    let timer: ReturnType<typeof setTimeout>;
    const run = async () => {
      if (stopped || working || document.hidden) return;
      working = true;
      let heartbeat: ReturnType<typeof setInterval> | undefined;
      try {
        const jobs = await request<PdfJob[]>('/api/pdf-index/jobs'),
          candidate = jobs.find(
            (job) =>
              job.status === 'queued' ||
              (job.status === 'running' &&
                !!job.leaseUntil &&
                job.leaseUntil < new Date().toISOString()),
          );
        if (!candidate) return;
        current = await send<PdfJob>(`/api/pdf-index/jobs/${idPath(candidate.id)}/claim`, 'POST');
        if (current.status === 'complete') return;
        controller = new AbortController();
        const signal = controller.signal,
          job = current;
        const { extractPdfPages } = await import('../../shared/media/pdf-text'),
          asset = await fetchAsset(job.assetId);
        signal.throwIfAborted();
        let pageCount = job.pageCount,
          pages: import('../../../shared/pdf/text').PdfExtractedPage[] = [],
          batchCharacters = 0;
        const flush = async () => {
          if (!pages.length) return;
          await send(`/api/pdf-index/jobs/${idPath(job.id)}/pages`, 'POST', {
            lease: job.lease,
            pageCount,
            pages,
          });
          pages = [];
          batchCharacters = 0;
          window.dispatchEvent(new Event('atlas-pdf-progress'));
        };
        for await (const page of extractPdfPages(decodeAsset(asset), {
          firstPage: job.nextPage,
          signal,
          onDocument: async (count) => {
            pageCount = count;
            await send(`/api/pdf-index/jobs/${idPath(job.id)}/pages`, 'POST', {
              lease: job.lease,
              pageCount,
              pages: [],
            });
            heartbeat = setInterval(() => {
              void send(`/api/pdf-index/jobs/${idPath(job.id)}/pages`, 'POST', {
                lease: job.lease,
                pageCount,
                pages: [],
              }).catch(() => controller?.abort());
            }, 30000);
          },
        })) {
          signal.throwIfAborted();
          pages.push(page);
          batchCharacters += page.text.length + page.items.length * 100;
          if (pages.length >= 8 || batchCharacters >= 1000000) await flush();
        }
        signal.throwIfAborted();
        await flush();
        await send(`/api/pdf-index/jobs/${idPath(job.id)}/pages`, 'POST', {
          lease: job.lease,
          pageCount,
          pages: [],
          complete: true,
        });
      } catch (error) {
        if (current?.lease && !controller?.signal.aborted)
          await send(`/api/pdf-index/jobs/${idPath(current.id)}/control`, 'POST', {
            action: 'fail',
            lease: current.lease,
            error: (error as Error).message || '无法解析PDF',
          }).catch(() => {});
      } finally {
        if (heartbeat) clearInterval(heartbeat);
        if (controller?.signal.aborted && current?.lease)
          await send(`/api/pdf-index/jobs/${idPath(current.id)}/control`, 'POST', {
            action: 'release',
            lease: current.lease,
          }).catch(() => {});
        current = undefined;
        controller = undefined;
        working = false;
        window.dispatchEvent(new Event('atlas-pdf-progress'));
        if (!stopped) timer = setTimeout(() => void run(), 5000);
      }
    };
    const wake = () => {
        clearTimeout(timer);
        void run();
      },
      visibility = () => {
        if (document.hidden) controller?.abort();
        else wake();
      },
      cancel = (event: Event) => {
        if ((event as CustomEvent<string>).detail === current?.id) controller?.abort();
      };
    window.addEventListener('atlas-pdf-jobs', wake);
    window.addEventListener('atlas-pdf-cancel', cancel);
    document.addEventListener('visibilitychange', visibility);
    timer = setTimeout(() => void run(), 1000);
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
      window.removeEventListener('atlas-pdf-jobs', wake);
      window.removeEventListener('atlas-pdf-cancel', cancel);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, []);
  return null;
}
