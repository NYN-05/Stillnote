import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));

export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed ? trimmed.split(/\s+/u).length : 0;
}

export function sanitizeFilename(value: string): string {
  return (
    value
      .normalize('NFKC')
      // Control characters are invalid in filenames on every platform.
      // eslint-disable-next-line no-control-regex
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .slice(0, 100) || 'untitled-note'
  );
}

export function downloadText(filename: string, text: string, mime: string) {
  const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

export function formatNoteDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return 'Recently';
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString([], sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}

export function previewText(content: string | null | undefined, snippet?: string, words = 14): string {
  return (content ?? snippet ?? '')
    .replace(/[#>*_`~[\]-]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, words)
    .join(' ');
}
