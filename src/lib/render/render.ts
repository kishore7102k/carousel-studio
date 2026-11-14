import { chromium, type Browser } from 'playwright-core';
import { put } from '@vercel/blob';
import type { Slide } from '@/lib/slides';
import type { BrandPack } from '@/lib/brand';
import { slideHtml, W, H } from './html';

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

/** Renders slides to 1080x1350 PNG buffers. */
export async function renderPngs(slides: Slide[], tipLabel: string, brand: BrandPack): Promise<Buffer[]> {
  const browser = await launch();
  try {
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    const out: Buffer[] = [];
    for (let i = 0; i < slides.length; i++) {
      await page.setContent(slideHtml(slides[i], i, slides.length, tipLabel, brand), { waitUntil: 'load' });
      await page.evaluate(() => document.fonts.ready);
      out.push(await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: W, height: H } }));
    }
    return out;
  } finally {
    await browser.close();
  }
}

/** Renders and uploads; returns public image URLs in slide order. */
export async function renderAndUpload(carouselId: string, version: number, slides: Slide[], tipLabel: string, brand: BrandPack) {
  const pngs = await renderPngs(slides, tipLabel, brand);
  const urls = await Promise.all(pngs.map((png, i) =>
    put(`carousels/${carouselId}/v${version}/${String(i + 1).padStart(2, '0')}.png`, png, {
      access: 'public', contentType: 'image/png', allowOverwrite: true, addRandomSuffix: false,
    }).then(b => b.url)));
  return urls;
}
