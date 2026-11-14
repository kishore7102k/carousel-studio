'use server';
import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { SESSION_COOKIE } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { Slides, starterSlides, type Slide } from '@/lib/slides';
import * as store from '@/lib/store';

const HUMAN = 'you';

export async function addNote(input: { carouselId: string; versionNumber: number; slideIndex: number; x: number; y: number; text: string }) {
  if (!input.text.trim()) return;
  await store.addRequest({ kind: 'note', ...input, text: input.text.trim() });
  revalidatePath(`/c/${input.carouselId}`);
}

export async function saveSlides(carouselId: string, slides: Slide[], note: string) {
  const parsed = Slides.safeParse(slides);
  if (!parsed.success) return { error: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ') };
  const res = await store.updateSlides({ id: carouselId, slides: parsed.data, createdBy: HUMAN, note: note || 'Edited in studio' });
  revalidatePath(`/c/${carouselId}`);
  return { version: res.version };
}

export async function setStatus(carouselId: string, status: store.Status) {
  await store.updateCarousel(carouselId, { status });
  revalidatePath(`/c/${carouselId}`);
  revalidatePath('/');
}

export async function switchVersion(carouselId: string, version: number) {
  await store.updateCarousel(carouselId, { currentVersion: version });
  revalidatePath(`/c/${carouselId}`);
}

export async function rerender(carouselId: string, version: number) {
  await store.renderCarousel(carouselId, version);
  revalidatePath(`/c/${carouselId}`);
}

export async function dismissRequest(id: string, carouselId?: string | null) {
  await store.setRequestStatus(id, 'dismissed');
  revalidatePath(carouselId ? `/c/${carouselId}` : '/requests');
  revalidatePath('/requests');
}

export async function requestNewCarousel(formData: FormData) {
  const text = String(formData.get('prompt') || '').trim();
  if (!text) return;
  await store.addRequest({ kind: 'new', text });
  revalidatePath('/requests');
  redirect('/requests');
}

export async function createBlank(formData: FormData) {
  const title = String(formData.get('title') || '').trim() || 'Untitled carousel';
  const tip = Number(formData.get('tipNumber')) || null;
  const res = await store.createCarousel({ title, tipNumber: tip, slides: starterSlides(), createdBy: HUMAN, note: 'Starter template' });
  redirect(`/c/${res.id}`);
}

export async function signOut() {
  (await cookies()).delete(SESSION_COOKIE);
  redirect('/login');
}

export async function deleteCarousel(carouselId: string) {
  await store.deleteCarousel(carouselId);
  revalidatePath('/');
  redirect('/');
}
