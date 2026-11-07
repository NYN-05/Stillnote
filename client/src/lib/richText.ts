import DOMPurify from 'dompurify';
import MarkdownIt from 'markdown-it';
import { policy } from './model';
import { copyText, downloadText } from './utils';

const markdown = new MarkdownIt({
  html: false, // Legacy Markdown never rendered embedded HTML; keep that promise.
  breaks: true,
  linkify: false,
  typographer: false,
});
markdown.enable(['table', 'strikethrough']);

const ALLOWED_ATTRIBUTES = [...new Set(Object.values(policy.allowedAttributes).flat())];

function isRelative(value: string): boolean {
  return !/^\/\//.test(value) && !/^[a-z][a-z0-9+.-]*:/i.test(value);
}

function isSafeUrl(value: string, schemes: readonly string[], allowRelative = true): boolean {
  const url = value.trim();
  // Control characters are never valid in a link and can smuggle schemes past parsers.
  // eslint-disable-next-line no-control-regex
  if (!url || /[\u0000-\u001f]/.test(url)) return false;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase();
  if (scheme) return schemes.includes(scheme);
  return allowRelative && isRelative(url);
}

export const isSafeLink = (value: string) => isSafeUrl(value, policy.linkSchemes, true);
const isSafeImage = (value: string) => isSafeUrl(value, policy.imageSchemes, true);

export function normalizeLinkUrl(value: string): string {
  const url = value.trim();
  if (!url) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || /^(?:\/|#|\?|\.{1,2}\/)/.test(url)) return url;
  return `https://${url}`;
}

function filterStyle(element: HTMLElement, tag: string): void {
  const allowed = policy.allowedStyles[tag as keyof typeof policy.allowedStyles] as Record<string, string[]> | undefined;
  if (!allowed) {
    element.removeAttribute('style');
    return;
  }
  const safe: string[] = [];
  for (const [property, values] of Object.entries(allowed)) {
    const value = element.style.getPropertyValue(property).trim().toLowerCase();
    if (!value) continue;
    const valid = property === 'text-align' ? values.includes(value) : values.includes('px') && /^\d+(?:\.\d+)?px$/.test(value);
    if (valid) safe.push(`${property}: ${value}`);
  }
  if (safe.length) element.setAttribute('style', safe.join('; '));
  else element.removeAttribute('style');
}

function cleanAttributes(element: Element, tag: string): boolean {
  const allowed = policy.allowedAttributes[tag as keyof typeof policy.allowedAttributes] ?? [];
  for (const attribute of [...element.attributes]) {
    if (!allowed.includes(attribute.name)) element.removeAttribute(attribute.name);
  }

  if (tag === 'a') {
    const href = element.getAttribute('href');
    if (!href || !isSafeLink(href)) {
      element.removeAttribute('href');
      element.removeAttribute('target');
      element.removeAttribute('rel');
    } else {
      element.setAttribute('target', policy.linkTarget);
      element.setAttribute('rel', policy.linkRel);
    }
  }

  if (tag === 'img') {
    const src = element.getAttribute('src');
    if (!src || !isSafeImage(src)) return false;
  }

  if (tag === 'th' || tag === 'td') {
    for (const name of ['colspan', 'rowspan']) {
      const value = element.getAttribute(name);
      if (value === null) continue;
      const span = Number.parseInt(value, 10);
      if (!Number.isInteger(span) || span < 1 || span > 1000) element.removeAttribute(name);
      else element.setAttribute(name, String(span));
    }
  }

  if (element.hasAttribute('style') || tag in policy.allowedStyles) filterStyle(element as HTMLElement, tag);
  return true;
}

/**
 * Browser-side counterpart of the server sanitizer. It shares the allowlist,
 * scheme rules and CSS restrictions, so pasted HTML and exported HTML cannot
 * contain anything the server would store differently.
 */
export function sanitizeRichHtml(html: string): string {
  const clean = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: policy.allowedTags,
    ALLOWED_ATTR: [...ALLOWED_ATTRIBUTES, 'style'],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'svg', 'math'],
    ALLOW_UNKNOWN_PROTOCOLS: false,
  });

  const template = document.createElement('template');
  template.innerHTML = clean;
  for (const element of [...template.content.querySelectorAll('*')]) {
    if (!cleanAttributes(element, element.tagName.toLowerCase())) element.remove();
  }
  return template.innerHTML;
}

export function markdownToHtml(source: string): string {
  return sanitizeRichHtml(markdown.render(source));
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 16)));
}

/** Plain text for previews, word counts, search and exports. Never exposes tags or Markdown markers. */
export function htmlToPlainText(value: string | null | undefined): string {
  if (!value) return '';
  if (!/<[a-z!/][^>]*>/i.test(value)) {
    // A legacy snippet can still contain Markdown markers; they are noise in a preview.
    return value
      .replace(/[#>*_`~[\]]+/g, ' ')
      .replace(/\s+/gu, ' ')
      .trim();
  }
  if (typeof DOMParser !== 'undefined') {
    const document = new DOMParser().parseFromString(value, 'text/html');
    document.querySelectorAll('script, style').forEach((node) => node.remove());
    return (document.body.textContent ?? '').replace(/\s+/gu, ' ').trim();
  }
  return decodeEntities(value.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/gu, ' ')
    .trim();
}

export function previewText(content: string | null | undefined, snippet?: string, words = 14): string {
  return htmlToPlainText(content ?? snippet ?? '')
    .split(' ')
    .filter(Boolean)
    .slice(0, words)
    .join(' ');
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

/** A standalone, script-free document for download and printing. */
function exportHtmlDocument(title: string, body: string): string {
  const safeTitle = escapeHtml(title || 'Untitled note');
  const safeBody = sanitizeRichHtml(body);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src http: https:; style-src 'unsafe-inline'">
<title>${safeTitle}</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; background: #fff; color: #18181b; font: 16px/1.75 Georgia, 'Times New Roman', serif; }
  article { max-width: 720px; margin: 0 auto; padding: 48px 24px 80px; overflow-wrap: anywhere; }
  h1, h2, h3, h4, h5, h6 { line-height: 1.25; letter-spacing: -0.015em; }
  h1 { font-size: 2rem; } h2 { font-size: 1.5rem; } h3 { font-size: 1.2rem; }
  a { color: #5f3fd6; }
  img { max-width: 100%; height: auto; }
  blockquote { margin: 1.2em 0; border-left: 3px solid #5f3fd6; padding-left: 1em; color: #52525b; }
  code, pre { font-family: ui-monospace, Consolas, monospace; }
  code { background: #f4f4f5; border-radius: 4px; padding: 0.12em 0.3em; }
  pre { overflow-x: auto; background: #f4f4f5; border-radius: 10px; padding: 1rem; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid #d4d4d8; padding: 0.45em 0.65em; text-align: left; }
  th { background: #f4f4f5; }
  .note-title { margin-bottom: 1.4em; }
</style>
</head>
<body>
<article>
<h1 class="note-title">${safeTitle}</h1>
${safeBody}
</article>
</body>
</html>`;
}

export function downloadHtml(filename: string, title: string, body: string): void {
  downloadText(filename, exportHtmlDocument(title, body), 'text/html');
}

export function printRichText(title: string, body: string): void {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  frame.srcdoc = exportHtmlDocument(title, body);
  frame.onload = () => {
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
    setTimeout(() => frame.remove(), 1000);
  };
  document.body.appendChild(frame);
}

/** Copies formatted text when the browser permits it, with a plain-text fallback. */
export async function copyRichText(html: string): Promise<boolean> {
  const safe = sanitizeRichHtml(html);
  try {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([safe], { type: 'text/html' }),
          'text/plain': new Blob([htmlToPlainText(safe)], { type: 'text/plain' }),
        }),
      ]);
      return true;
    }
  } catch {
    // Some browsers expose ClipboardItem but refuse rich writes; fall through.
  }
  return copyText(htmlToPlainText(safe));
}
