import {Children,isValidElement,memo,useRef,type ReactNode} from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {AssetImage,safeEmbeddedImage} from '../media/asset-render';
import {assetIdFromUrl} from '../../../shared/assets/assets';

// Answer clocks, typing and status updates do not change the Markdown source.
// Keep its parser and embedded media mounted until the source itself changes.
const MarkdownRenderer = memo(function MarkdownRenderer({ children }: { children: string }) {
  const container = useRef<HTMLDivElement>(null);
  const transform = (url: string, key: string) => { if (key === 'src' && (assetIdFromUrl(url) || safeEmbeddedImage(url))) return url; if (/^https?:\/\//i.test(url) || url.startsWith('#')) return url; return ''; };
  const plainText = (nodes: ReactNode): string => Children.toArray(nodes).map(node => typeof node === 'string' || typeof node === 'number' ? String(node) : isValidElement<{ children?: ReactNode }>(node) ? plainText(node.props.children) : '').join('');
  const slug = (nodes: ReactNode) => plainText(nodes).toLowerCase().trim().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/\s+/g, '-');
  const anchorId = (url: string) => { try { const value = decodeURIComponent(url.slice(1)); return /^[\p{L}\p{N}_.:+-]+$/u.test(value) ? value : ''; } catch { return ''; } };
  return <div className="markdown" ref={container}><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={transform} components={{
    a: ({ href, children }) => {
      if (!href) return <span>{children}</span>;
      const localAnchor = href.startsWith('#') && !href.startsWith('#/');
      const id = localAnchor ? anchorId(href) : '';
      if (localAnchor && !plainText(children).trim()) return id ? <span id={id} className="document-anchor" /> : null;
      return <a href={href} {...(href.startsWith('http') ? { target: '_blank', rel: 'noopener noreferrer' } : {})} onClick={event => {
        if (!localAnchor) return;
        event.preventDefault();
        if (!id) return;
        const target = container.current?.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`) || document.getElementById(id);
        target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }}>{children}</a>;
    },
    h1: ({ children }) => <h1 id={slug(children)}>{children}</h1>,
    h2: ({ children }) => <h2 id={slug(children)}>{children}</h2>,
    h3: ({ children }) => <h3 id={slug(children)}>{children}</h3>,
    h4: ({ children }) => <h4 id={slug(children)}>{children}</h4>,
    h5: ({ children }) => <h5 id={slug(children)}>{children}</h5>,
    h6: ({ children }) => <h6 id={slug(children)}>{children}</h6>,
    img: ({ alt, src }) => <AssetImage src={src} alt={alt} />, table: ({ children }) => <div className="table-scroll"><table>{children}</table></div>
  }}>{children}</ReactMarkdown></div>;
});

export default MarkdownRenderer;
