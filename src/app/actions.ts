'use server';
import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { SESSION_COOKIE } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { Slides, starterSlides, type Slide } from '@/lib/slides';
import * as store from '@/lib/store';
import { getBrand, tipLabel } from '@/lib/brand';
import { previewSlide, templateToDesign } from '@/lib/render/design';
import { deleteLayout } from '@/lib/layouts';
import type { DesignSlide } from '@/lib/slides';

const HUMAN = 'you';
const log = (action: string, carouselId?: string | null, detail?: Record<string, unknown>) => store.logActivity(HUMAN, action, carouselId, detail);

export async function addNote(input: { carouselId: string; versionNumber: number; slideIndex: number; x: number; y: number; text: string }) {
  if (!input.text.trim()) return;
  await store.addRequest({ kind: 'note', ...input, text: input.text.trim() });
  await log('add_note', input.carouselId, { slide: input.slideIndex + 1, version: input.versionNumber });
  revalidatePath(`/c/${input.carouselId}`);
}

export async function saveSlides(carouselId: string, slides: Slide[], note: string) {
  const parsed = Slides.safeParse(slides);
  if (!parsed.success) return { error: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') };
  const res = await store.updateSlides({ id: carouselId, slides: parsed.data, createdBy: HUMAN, note: note || 'Edited in studio' });
  await log('update_slides', carouselId, { version: res.version, slides: parsed.data.length });
  revalidatePath(`/c/${carouselId}`);
  return { version: res.version };
}

export async function setStatus(carouselId: string, status: store.Status) {
  await store.updateCarousel(carouselId, { status });
  await log('update_carousel', carouselId, { status });
  revalidatePath(`/c/${carouselId}`);
  revalidatePath('/');
}

export async function switchVersion(carouselId: string, version: number) {
  await store.updateCarousel(carouselId, { currentVersion: version });
  await log('set_current_version', carouselId, { version });
  revalidatePath(`/c/${carouselId}`);
}

export async function rerender(carouselId: string, version: number) {
  await store.renderCarousel(carouselId, version);
  await log('render_carousel', carouselId, { version });
  revalidatePath(`/c/${carouselId}`);
}

export async function dismissRequest(id: string, carouselId?: string | null) {
  await store.setRequestStatus(id, 'dismissed');
  await log('dismiss_request', carouselId, { requestId: id });
  revalidatePath(carouselId ? `/c/${carouselId}` : '/requests');
  revalidatePath('/requests');
}

export async function requestNewCarousel(formData: FormData) {
  const text = String(formData.get('prompt') || '').trim();
  if (!text) return;
  await store.addRequest({ kind: 'new', text });
  await log('request_carousel', null, { prompt: text.slice(0, 200) });
  revalidatePath('/requests');
  redirect('/requests');
}

export async function createBlank(formData: FormData) {
  const title = String(formData.get('title') || '').trim() || 'Untitled carousel';
  const tip = Number(formData.get('tipNumber')) || null;
  const res = await store.createCarousel({ title, tipNumber: tip, slides: starterSlides(), createdBy: HUMAN, note: 'Starter template' });
  await log('create_carousel', res.id, { title });
  redirect(`/c/${res.id}`);
}

export async function signOut() {
  (await cookies()).delete(SESSION_COOKIE);
  redirect('/login');
}

export async function deleteCarousel(carouselId: string) {
  await store.deleteCarousel(carouselId);
  await log('delete_carousel', carouselId);
  revalidatePath('/');
  redirect('/');
}

export async function restoreCarousel(carouselId: string) {
  await store.restoreCarousel(carouselId);
  await log('restore_carousel', carouselId);
  revalidatePath('/');
}

/** Permanent delete; the store refuses unless the carousel is already in the trash. */
export async function purgeCarousel(carouselId: string) {
  const res = await store.purgeCarousel(carouselId);
  await log('purge_carousel', null, { id: carouselId, title: res.title });
  revalidatePath('/');
}

/** Copies the current version into a new carousel and renders it so the copy has images. */
export async function duplicateCarousel(carouselId: string, version?: number) {
  const res = await store.duplicateCarousel({ id: carouselId, version, createdBy: HUMAN, render: true });
  await log('duplicate_carousel', res.id, { from: carouselId });
  revalidatePath('/');
  redirect(`/c/${res.id}`);
}

type EditorSlide = Slide | DesignSlide;

/** Renders one slide in the locked-down browser without saving; returns a PNG data URL plus lint results. */
export async function previewDesign(carouselId: string, slide: EditorSlide, n: number, total: number) {
  try {
    const [brand, got] = await Promise.all([getBrand(), store.getCarousel(carouselId)]);
    const res = await previewSlide(slide, { n, total, tipLabel: tipLabel(brand, got?.carousel.tipNumber ?? null), brand });
    return { dataUrl: `data:image/png;base64,${Buffer.from(res.png).toString('base64')}`, errors: res.errors, warnings: res.warnings };
  } catch (e) {
    return { dataUrl: null, errors: [e instanceof Error ? e.message : String(e)], warnings: [] as string[] };
  }
}

/** Converts a template slide into an editable design slide that renders the same. */
export async function convertToDesign(carouselId: string, slide: Slide, i: number, total: number): Promise<{ slide: DesignSlide } | { error: string }> {
  try {
    const [brand, got] = await Promise.all([getBrand(), store.getCarousel(carouselId)]);
    return { slide: templateToDesign(slide, i, total, tipLabel(brand, got?.carousel.tipNumber ?? null), brand) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export async function removeLayout(name: string) {
  await deleteLayout(name);
  await log('delete_layout', null, { name });
  revalidatePath('/layouts');
}
