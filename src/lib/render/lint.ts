// Design checks measured in the rendered page. page.evaluate runs through the DevTools protocol, so it works
// while the page's own JavaScript is disabled. The function below is serialized into the page: keep it self-contained.
import type { Page } from 'playwright-core';
import { family, type BrandPack } from '@/lib/brand';
import { brandPalette, H, SAFE, W } from './brand-layer';
import type { Lint } from './render';

export type LintOptions = { W: number; H: number; safe: number; palette: [number, number, number, number][]; fonts: string[] };

/** [r, g, b, alpha]: a token with alpha (e.g. #ffffff0a) only allows colors at most that opaque. */
const hexRgb = (hex: string): [number, number, number, number] | null => {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})([0-9a-f]{2})?$/i.exec(hex.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].split('').map(c => c + c).join('') : m[1];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), m[2] ? parseInt(m[2], 16) / 255 : 1];
};
const firstFamily = (stack: string) => stack.split(',')[0].trim().replace(/^["']|["']$/g, '').toLowerCase();

export function lintOptions(brand: BrandPack): LintOptions {
  return {
    W, H, safe: SAFE,
    palette: brandPalette(brand).map(hexRgb).filter((x): x is [number, number, number, number] => !!x),
    fonts: [firstFamily(family(brand, 'sans')), firstFamily(family(brand, 'mono'))],
  };
}

/** Lints the slide currently loaded in `page`. */
export async function lintSlide(page: Page, opts: LintOptions): Promise<Lint> {
  // Dev runners (tsx/esbuild keepNames) wrap inner functions in __name(); give the page a no-op one.
  await page.evaluate('globalThis.__name = globalThis.__name || (f => f)');
  return page.evaluate(inPage, opts);
}

function inPage(o: LintOptions): Lint {
  const errors: string[] = [];
  const warnings: string[] = [];
  const root = document.querySelector('section.slide') as HTMLElement | null;
  if (!root) return { errors, warnings };

  const desc = (el: Element) => {
    const t = (el.textContent ?? '').trim().replace(/\s+/g, ' ');
    const cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).join('.') : '';
    return `<${el.tagName.toLowerCase()}${cls}>${t ? ` "${t.length > 40 ? t.slice(0, 39) + '…' : t}"` : ''}`;
  };
  const px = (n: number) => `${Math.round(n)}px`;
  type Box = { left: number; top: number; right: number; bottom: number };
  const union = (a: Box | null, r: Box): Box => (a ? { left: Math.min(a.left, r.left), top: Math.min(a.top, r.top), right: Math.max(a.right, r.right), bottom: Math.max(a.bottom, r.bottom) } : { left: r.left, top: r.top, right: r.right, bottom: r.bottom });
  const opacity = (el: Element | null) => { let v = 1; for (let e = el; e; e = e.parentElement) v *= parseFloat(getComputedStyle(e).opacity || '1'); return v; };

  // ---- text and media boxes ----
  const texts = new Map<Element, Box>();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.textContent?.trim()) continue;
    const el = n.parentElement;
    if (!el) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || opacity(el) < 0.05) continue;
    range.selectNodeContents(n);
    let box: Box | null = null;
    for (const r of Array.from(range.getClientRects())) if (r.width > 0 && r.height > 0) box = union(box, r);
    if (box) texts.set(el, union(texts.get(el) ?? null, box));
  }
  const media = new Map<Element, Box>();
  for (const el of Array.from(root.querySelectorAll('img,svg,video,canvas,picture'))) {
    if (el.parentElement?.closest('svg')) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden') media.set(el, r);
  }
  const boxes = [...texts, ...media];

  // ---- canvas, safe area, clipping, chrome overlap ----
  const chrome = document.querySelector('footer.chrome');
  const cb = chrome && chrome.textContent?.trim() ? chrome.getBoundingClientRect() : null;
  for (const [el, b] of boxes) {
    const off = [b.left < -1 && `left edge at ${px(b.left)}`, b.top < -1 && `top edge at ${px(b.top)}`, b.right > o.W + 1 && `right edge at ${px(b.right)}`, b.bottom > o.H + 1 && `bottom edge at ${px(b.bottom)}`].filter(Boolean);
    if (off.length) { errors.push(`${desc(el)} is off the ${o.W}x${o.H} canvas (${off.join(', ')})`); continue; }
    const out = [b.left < o.safe - 1 && 'left', b.top < o.safe - 1 && 'top', b.right > o.W - o.safe + 1 && 'right', b.bottom > o.H - o.safe + 1 && 'bottom'].filter(Boolean);
    if (out.length) warnings.push(`${desc(el)} is outside the ${o.safe}px safe area (${out.join(', ')})`);
    for (let a = el.parentElement; a && a !== root.parentElement; a = a.parentElement) {
      const cs = getComputedStyle(a);
      if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
      const r = a.getBoundingClientRect();
      if (b.left < r.left - 2 || b.top < r.top - 2 || b.right > r.right + 2 || b.bottom > r.bottom + 2) {
        if (a !== root) warnings.push(`${desc(el)} is clipped by its container ${desc(a).split(' ')[0]}`);
        break;
      }
    }
    if (cb && b.left < cb.right && b.right > cb.left && b.top < cb.bottom && b.bottom > cb.top) warnings.push(`${desc(el)} overlaps the handle/counter footer (set chrome "none" or leave the bottom ${px(o.H - cb.top + 24)} free)`);
  }

  // ---- type: size and family ----
  const small: string[] = [];
  const fams = new Map<string, string>();
  for (const el of texts.keys()) {
    const cs = getComputedStyle(el);
    const size = parseFloat(cs.fontSize);
    if (size < 24) small.push(`${desc(el)} ${px(size)}`);
    const fam = cs.fontFamily.split(',')[0].trim().replace(/^["']|["']$/g, '');
    if (!o.fonts.includes(fam.toLowerCase()) && !fams.has(fam)) fams.set(fam, desc(el));
  }
  if (small.length) warnings.push(`text under 24px (unreadable on a phone): ${small.slice(0, 3).join('; ')}${small.length > 3 ? ` and ${small.length - 3} more` : ''}`);
  for (const [fam, where] of fams) warnings.push(`font "${fam}" is not a brand font (${o.fonts.join(', ')}): ${where}`);

  // ---- colors ----
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const rgba = (c: string): [number, number, number, number] | null => {
    let m = /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/.exec(c);
    if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
    m = /^color\(srgb ([-\d.e]+) ([-\d.e]+) ([-\d.e]+)(?: \/ ([\d.]+))?\)$/.exec(c);
    if (m) return [+m[1] * 255, +m[2] * 255, +m[3] * 255, m[4] === undefined ? 1 : +m[4]];
    if (!ctx || c === 'none' || c.startsWith('url(')) return null;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = c;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  };
  // No palette check: each carousel picks its own colors (maintainer decision 2026-11-15). Only contrast is enforced below.

  // ---- one marker ----
  const marks = root.querySelectorAll('mark').length;
  if (marks > 1) warnings.push(`${marks} <mark> phrases: the brand uses ONE marked phrase per slide`);

  // ---- contrast (WCAG AA on solid grounds; skipped over images/gradients) ----
  const lum = (c: number[]) => {
    const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const over = (top: number[], a: number, under: number[]) => [0, 1, 2].map(k => top[k] * a + under[k] * (1 - a));
  const low: string[] = [];
  for (const el of texts.keys()) {
    if (el.closest('mark, .editor .rm')) continue; // marker and removed diff rows are styled on purpose
    const layers: [number, number, number, number][] = [];
    let image = false;
    for (let e: Element | null = el; e; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.backgroundImage !== 'none') { image = true; break; }
      const c = rgba(cs.backgroundColor);
      if (c && c[3] > 0) layers.push(c);
      if (c && c[3] >= 1) break;
    }
    if (image) continue;
    let bg = [255, 255, 255];
    for (const l of layers.reverse()) bg = over(l, l[3], bg);
    const fg = rgba(getComputedStyle(el).color);
    if (!fg) continue;
    const text = over(fg, fg[3] * opacity(el), bg);
    const [a, b] = [lum(text), lum(bg)].sort((x, y) => y - x);
    const ratio = (a + 0.05) / (b + 0.05);
    const cs = getComputedStyle(el);
    const size = parseFloat(cs.fontSize);
    const need = size >= 64 || (parseInt(cs.fontWeight, 10) >= 700 && size >= 48) ? 3 : 4.5;
    if (ratio < need) low.push(`${desc(el)} ${(Math.floor(ratio * 100) / 100).toFixed(2)}:1 (needs ${need}:1)`);
  }
  if (low.length) warnings.push(`low text contrast: ${low.slice(0, 3).join('; ')}${low.length > 3 ? ` and ${low.length - 3} more` : ''}`);

  return { errors: [...new Set(errors)].slice(0, 10), warnings: [...new Set(warnings)].slice(0, 20) };
}
