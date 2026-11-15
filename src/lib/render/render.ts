import { chromium, type Browser } from 'playwright-core';
import { put } from '@vercel/blob';
import type { Slide } from '@/lib/slides';
import type { BrandPack } from '@/lib/brand';
import { assetHost } from '@/lib/assets';
import { slideHtml, W, H } from './html';
import { lintOptions, lintSlide } from './lint';
import { logError } from '@/lib/errors';

export type Lint = { errors: string[]; warnings: string[] };
export type Rendered = { png: Buffer; lint: Lint | null };

// ---------- lockdown ----------
// Every slide (templates too) renders with page JavaScript off, every request aborted except data: URLs and the
// studio's own Blob host, DNS for any other host disabled, and a CSP meta tag as a second wall.

const allowedUrl = (url: string, host: string | null) =>
  url.startsWith('data:') || (!!host && url.toLowerCase().startsWith(`https://${host}/`));

export function cspMeta(host: string | null) {
  const img = `data:${host ? ` https://${host}` : ''}`;
  return `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${img}; font-src data:; style-src 'unsafe-inline'; media-src ${img}; base-uri 'none'; form-action 'none'">`;
}

/** Puts the CSP meta first in <head> (before anything that could load). The slide HTML itself is unchanged. */
export const lockHtml = (html: string, host: string | null) =>
  html.includes('<head>') ? html.replace('<head>', `<head>${cspMeta(host)}`) : `${cspMeta(host)}${html}`;

// @sparticuz/chromium unpacks its binary to /tmp/chromium on first use. Under Vercel Fluid compute several requests
// share one instance; two concurrent executablePath() calls both wrote /tmp/chromium while a third launched it, and
// the launch failed with "spawn ETXTBSY". Unpack ONCE per instance (one shared promise; reset if it fails).
let serverlessChromium: Promise<{ executablePath: string; args: string[] }> | null = null;
function getServerlessChromium() {
  serverlessChromium ??= (async () => {
    const sparticuz = (await import('@sparticuz/chromium')).default;
    // --single-process is meant for AWS Lambda. With Playwright contexts + request interception it makes the browser
    // die mid-render ("Target page, context or browser has been closed"); Vercel functions can run child processes.
    return { executablePath: await sparticuz.executablePath(), args: sparticuz.args.filter(a => a !== '--single-process') };
  })().catch(err => { serverlessChromium = null; throw err; });
  return serverlessChromium;
}

async function launch(host: string | null): Promise<Browser> {
  // Any hostname other than the asset host resolves to nothing (no DNS lookups, no prefetch leaks).
  const lockArgs = [`--host-resolver-rules=MAP * ~NOTFOUND${host ? `, EXCLUDE ${host}` : ''}`, '--dns-prefetch-disable', '--disable-background-networking'];
  if (process.env.VERCEL) {
    const { executablePath, args } = await getServerlessChromium();
    return chromium.launch({ executablePath, args: [...args, ...lockArgs], headless: true });
  }
  // Local dev: use an installed browser (Edge ships with Windows) or CHROME_PATH.
  return process.env.CHROME_PATH
    ? chromium.launch({ executablePath: process.env.CHROME_PATH, args: lockArgs, headless: true })
    : chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : 'chrome', args: lockArgs, headless: true });
}

/** Browser-level failures (crash, closed target, compositor hiccup, binary busy) are retried once with a fresh browser. */
const BROWSER_FLAKE = /has been closed|Target closed|browser has disconnected|crash|Unable to capture screenshot|Protocol error|ETXTBSY|EAGAIN/i;

// At most MAX_BROWSERS Chromium processes per server instance; extra renders wait their turn instead of
// launching side by side (memory pressure on a shared serverless instance, binary contention).
const MAX_BROWSERS = 2;
let activeBrowsers = 0;
const waiting: (() => void)[] = [];
async function withBrowserSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeBrowsers >= MAX_BROWSERS) await new Promise<void>(resolve => waiting.push(resolve));
  activeBrowsers++;
  try {
    return await fn();
  } finally {
    activeBrowsers--;
    waiting.shift()?.();
  }
}

/** Renders full HTML pages to 1080x1350 PNGs in one locked-down browser. Pages with lint: true are also checked. */
export async function renderPages(pages: { html: string; lint: boolean }[], brand: BrandPack): Promise<Rendered[]> {
  return withBrowserSlot(async () => {
    try {
      return await renderPagesOnce(pages, brand);
    } catch (err) {
      if (!BROWSER_FLAKE.test(String(err))) throw err;
      console.error('render: browser failure, retrying once with a fresh browser:', String(err).slice(0, 300));
      // recovered by the retry below: logged as expected so the Errors page can still show how often it happens
      await logError({ source: 'render', error: err, detail: { recovered: 'retrying once with a fresh browser', pages: pages.length }, expected: true });
      await new Promise(r => setTimeout(r, 250));
      return renderPagesOnce(pages, brand);
    }
  });
}

async function renderPagesOnce(pages: { html: string; lint: boolean }[], brand: BrandPack): Promise<Rendered[]> {
  const host = assetHost();
  const browser = await launch(host);
  try {
    const context = await browser.newContext({
      viewport: { width: W, height: H }, deviceScaleFactor: 1, javaScriptEnabled: false, serviceWorkers: 'block', acceptDownloads: false,
    });
    let blocked: string[] = [];
    await context.route('**/*', route => {
      const url = route.request().url();
      if (allowedUrl(url, host)) return route.continue();
      blocked.push(url);
      return route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    page.setDefaultTimeout(20_000);
    const opts = pages.some(p => p.lint) ? lintOptions(brand) : null;
    const out: Rendered[] = [];
    for (const p of pages) {
      blocked = [];
      let png: Buffer;
      let lint: Lint | null = null;
      try {
        await page.setContent(lockHtml(p.html, host), { waitUntil: 'load' });
        await page.evaluate(() => document.fonts.ready);
        png = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: W, height: H } });
        if (p.lint && opts) lint = await lintSlide(page, opts);
        if (page.url() !== 'about:blank') throw new Error('navigated');
      } catch (err) {
        // A navigation (e.g. meta refresh) was aborted by the route but replaced the document: never ship that image.
        if (page.url() !== 'about:blank' || /context was destroyed|navigat/i.test(String(err))) {
          throw new Error('the slide tried to navigate away (meta refresh or similar); remove it');
        }
        throw err;
      }
      if (lint) {
        const urls = [...new Set(blocked.filter(u => !u.startsWith('about:')))];
        if (urls.length) lint.warnings.push(`blocked ${urls.length} request(s) (only data: URIs and upload_asset URLs load): ${urls.slice(0, 3).map(u => u.slice(0, 80)).join(', ')}`);
      }
      out.push({ png, lint });
    }
    return out;
  } finally {
    // A crashed browser can reject close(); that must not mask the real error (or block the retry).
    await browser.close().catch(() => {});
  }
}

/** Renders slides; design slides are also linted. */
export async function renderSlides(slides: Slide[], tipLabel: string, brand: BrandPack): Promise<Rendered[]> {
  return renderPages(slides.map((s, i) => ({ html: slideHtml(s, i, slides.length, tipLabel, brand), lint: s.kind === 'design' })), brand);
}

/** Renders slides to 1080x1350 PNG buffers. */
export async function renderPngs(slides: Slide[], tipLabel: string, brand: BrandPack): Promise<Buffer[]> {
  return (await renderSlides(slides, tipLabel, brand)).map(r => r.png);
}

/** Uploads rendered PNGs; returns public image URLs in slide order. */
export async function uploadPngs(carouselId: string, version: number, pngs: Buffer[]) {
  return Promise.all(pngs.map((png, i) =>
    put(`carousels/${carouselId}/v${version}/${String(i + 1).padStart(2, '0')}.png`, png, {
      access: 'public', contentType: 'image/png', allowOverwrite: true, addRandomSuffix: false,
    }).then(b => b.url)));
}

/** Renders and uploads; returns public image URLs in slide order. */
export async function renderAndUpload(carouselId: string, version: number, slides: Slide[], tipLabel: string, brand: BrandPack) {
  return uploadPngs(carouselId, version, await renderPngs(slides, tipLabel, brand));
}
