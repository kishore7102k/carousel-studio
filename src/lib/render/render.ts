import { chromium, type Browser } from 'playwright-core';
import { put } from '@vercel/blob';
import type { Slide } from '@/lib/slides';
import type { BrandPack } from '@/lib/brand';
import { slideHtml, W, H } from './html';

export type Lint = { errors: string[]; warnings: string[] };
export type Rendered = { png: Buffer; lint: Lint | null };

async function launch(): Promise<Browser> {
  if (process.env.VERCEL) {
    const sparticuz = (await import('@sparticuz/chromium')).default;
    return chromium.launch({ executablePath: await sparticuz.executablePath(), args: sparticuz.args, headless: true });
  }
  // Local dev: use an installed browser (Edge ships with Windows) or CHROME_PATH.
  return process.env.CHROME_PATH
    ? chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
    : chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : 'chrome', headless: true });
}

/** Renders full HTML pages to 1080x1350 PNGs in one browser. */
export async function renderPages(pages: { html: string; lint: boolean }[], brand: BrandPack): Promise<Rendered[]> {
  void brand;
  const browser = await launch();
  try {
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    const out: Rendered[] = [];
    for (const p of pages) {
      await page.setContent(p.html, { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready);
      out.push({ png: await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: W, height: H } }), lint: null });
    }
    return out;
  } finally {
    await browser.close();
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
