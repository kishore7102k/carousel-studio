// Phase 3 reusable design layouts. CONTRACT STUBS: Agent B implements (item 8).
import type { DesignSlide, LayoutRef, Slide } from '@/lib/slides';

export type Layout = { id: string; name: string; description: string; html: string; css: string; placeholders: string[]; thumbnail: string | null; createdBy: string; createdAt: Date; updatedAt: Date };

export async function listLayouts(): Promise<Layout[]> { return []; }
export async function getLayout(name: string): Promise<Layout | null> { void name; return null; }
export async function saveLayout(input: { name: string; description?: string; html: string; css?: string; createdBy: string }): Promise<Layout> {
  void input; throw new Error('saveLayout: not implemented yet (phase 3 item 8)');
}
export async function deleteLayout(name: string): Promise<boolean> { void name; return false; }

/** Fills a layout's {{placeholders}} (escaped text, *marker* and `code` allowed) into a DesignSlide. */
export async function applyLayout(ref: LayoutRef): Promise<DesignSlide> {
  void ref; throw new Error('applyLayout: not implemented yet (phase 3 item 8)');
}

/** Resolves any { kind:'design', layout } inputs to DesignSlides; other slides pass through unchanged. */
export async function resolveSlideInputs(slides: (Slide | DesignSlide | LayoutRef)[]): Promise<(Slide | DesignSlide)[]> {
  return Promise.all(slides.map(s => ('layout' in s ? applyLayout(s) : s)));
}
