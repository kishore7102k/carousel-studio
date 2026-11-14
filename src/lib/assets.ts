// Phase 3 uploaded assets (images/SVG for design slides). Global, not per carousel.
import { put, del } from '@vercel/blob';
import { desc, eq } from 'drizzle-orm';
import { getDb, schema } from '@/db';

export type Asset = { id: string; url: string; kind: string; bytes: number; width: number | null; height: number | null; createdBy: string; createdAt: Date };

export const MAX_ASSET_BYTES = 2 * 1024 * 1024;
const EXT: Record<string, string> = { png: 'png', jpeg: 'jpg', webp: 'webp', svg: 'svg' };
const MIME: Record<string, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml' };

type Dim = { width: number | null; height: number | null };

function pngDim(b: Buffer): Dim | null {
  if (b.length < 24 || b.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}
function jpegDim(b: Buffer): Dim | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1];
    if (m === 0xff) { i++; continue; }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    const len = b.readUInt16BE(i + 2);
    // SOF0-SOF15 except DHT (C4), JPG (C8), DAC (CC)
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    i += 2 + len;
  }
  return null;
}
function webpDim(b: Buffer): Dim | null {
  if (b.length < 30) return null;
  const t = b.toString('latin1', 12, 16);
  if (t === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  if (t === 'VP8L') {
    const v = b.readUInt32LE(21);
    return { width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1 };
  }
  if (t === 'VP8X') return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
  return null;
}

const num = (s: string | undefined) => { const n = s ? parseFloat(s) : NaN; return Number.isFinite(n) && n > 0 ? Math.round(n) : null; };
function svgDim(svg: string): Dim {
  const tag = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? '';
  const attr = (n: string) => new RegExp(`\\s${n}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag)?.[1];
  let width = attr('width')?.includes('%') ? null : num(attr('width'));
  let height = attr('height')?.includes('%') ? null : num(attr('height'));
  const vb = attr('viewBox')?.trim().split(/[\s,]+/).map(Number);
  if (vb && vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
    if (!width && !height) { width = Math.round(vb[2]); height = Math.round(vb[3]); }
    else if (!width && height) width = Math.round(height * vb[2] / vb[3]);
    else if (width && !height) height = Math.round(width * vb[3] / vb[2]);
  }
  return { width, height };
}

/** Removes script, foreignObject, event handlers, javascript: and any non-data external reference. */
export function sanitizeSvg(svg: string): string {
  let s = svg
    .replace(/<\?xml[\s\S]*?\?>/gi, '')
    .replace(/<!DOCTYPE[\s\S]*?(\]>|>)/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<script\b[^>]*\/?>/gi, '')
    .replace(/<foreignObject\b[\s\S]*?<\/foreignObject\s*>/gi, '')
    .replace(/<foreignObject\b[^>]*\/?>/gi, '')
    .replace(/<(iframe|object|embed|audio|video)\b[\s\S]*?(<\/\1\s*>|$)/gi, '')
    .replace(/<(link|meta|base)\b[^>]*>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  // href / xlink:href: keep only data:image and in-document #fragment references
  s = s.replace(/\s(?:xlink:)?href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi, (m, _all, a, b, c) => {
    const v = String(a ?? b ?? c ?? '').trim().toLowerCase();
    return v.startsWith('data:image/') || v.startsWith('#') ? m : '';
  });
  // url(...) in attributes/styles: keep only data:image and #fragment
  s = s.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (m, _q, u: string) => {
    const v = u.trim().toLowerCase();
    return v.startsWith('data:image/') || v.startsWith('#') ? m : 'none';
  });
  s = s.replace(/@import[^;]*;?/gi, '').replace(/javascript\s*:/gi, '');
  return s.trim();
}

export async function uploadAsset(input: { name: string; mimeType: string; base64: string; createdBy: string }): Promise<Asset> {
  const clean = input.base64.replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw new Error('base64 is not valid');
  if (clean.length * 0.75 > MAX_ASSET_BYTES + 4) throw new Error(`asset too large: max ${MAX_ASSET_BYTES / 1024 / 1024} MB`);
  let buf: Buffer = Buffer.from(clean, 'base64');
  if (!buf.length) throw new Error('asset is empty');
  if (buf.length > MAX_ASSET_BYTES) throw new Error(`asset too large: ${buf.length} bytes, max ${MAX_ASSET_BYTES}`);

  let kind: keyof typeof EXT | null = null;
  let dim: Dim | null = null;
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) { kind = 'png'; dim = pngDim(buf); }
  else if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) { kind = 'jpeg'; dim = jpegDim(buf); }
  else if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') { kind = 'webp'; dim = webpDim(buf); }
  else {
    const head = buf.toString('utf8').replace(/^﻿/, '');
    if (/<svg[\s>]/i.test(head) && /^\s*(<\?xml|<!--|<!DOCTYPE|<svg)/i.test(head)) kind = 'svg';
  }
  if (!kind) throw new Error('unsupported or corrupt file: only PNG, JPEG, WebP and SVG are accepted (checked by content, not by mimeType)');
  if (kind !== 'svg' && !dim) throw new Error(`corrupt ${kind.toUpperCase()}: could not read its dimensions`);
  if (kind === 'svg') {
    const svg = sanitizeSvg(buf.toString('utf8').replace(/^﻿/, ''));
    if (!/^<svg[\s>]/i.test(svg)) throw new Error('SVG is empty after sanitizing');
    buf = Buffer.from(svg, 'utf8');
    dim = svgDim(svg);
  }

  const db = getDb();
  const id = crypto.randomUUID();
  const blob = await put(`assets/${id}.${EXT[kind]}`, buf, { access: 'public', contentType: MIME[kind], allowOverwrite: true, addRandomSuffix: false });
  try {
    const [row] = await db.insert(schema.assets).values({
      id, url: blob.url, kind, bytes: buf.length, width: dim?.width ?? null, height: dim?.height ?? null, createdBy: input.createdBy,
    }).returning();
    return row;
  } catch (e) {
    await del(blob.url).catch(() => {});
    throw e;
  }
}

export async function listAssets(): Promise<Asset[]> {
  return getDb().select().from(schema.assets).orderBy(desc(schema.assets.createdAt));
}

export async function deleteAsset(id: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
  const db = getDb();
  const [row] = await db.delete(schema.assets).where(eq(schema.assets.id, id)).returning();
  if (!row) return false;
  await del(row.url).catch(() => {});
  return true;
}

/** Blob host that design slides may load images from (the renderer's network allow-list). */
export function assetHost(): string | null {
  const t = process.env.BLOB_READ_WRITE_TOKEN;
  const storeId = t?.split('_')[3];
  return storeId ? `${storeId.toLowerCase()}.public.blob.vercel-storage.com` : null;
}
