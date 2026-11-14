// Phase 3 render API for agent-designed slides. CONTRACT STUBS: Agent A implements (items 3-5).
import type { BrandPack } from '@/lib/brand';
import type { DesignSlide, Slide } from '@/lib/slides';

export type Lint = { errors: string[]; warnings: string[] };

/** Strips scripts, frames, external links, on* handlers, javascript: URLs, remote url()/@import from agent HTML/CSS. */
export function sanitizeDesign(input: { html: string; css?: string }): { html: string; css: string; removed: string[] } {
  void input;
  throw new Error('sanitizeDesign: not implemented yet (phase 3 item 3)');
}

/** Renders one slide in the locked-down browser (no JS, no network) without saving. */
export async function previewSlide(slide: Slide | DesignSlide, opts: { n?: number; total?: number; tipLabel?: string; brand?: BrandPack } = {}): Promise<{ png: Buffer } & Lint> {
  void slide; void opts;
  throw new Error('previewSlide: not implemented yet (phase 3 item 5)');
}

/** Converts any slide (template or design) into an editable design slide that renders the same. */
export function templateToDesign(slide: Slide, i: number, total: number, tipLabel: string, brand: BrandPack): DesignSlide {
  void slide; void i; void total; void tipLabel; void brand;
  throw new Error('templateToDesign: not implemented yet (phase 3 item 3)');
}

export type DesignSystem = {
  canvas: { width: number; height: number; safeInset: number };
  variables: { name: string; value: string; use: string }[];
  classes: { name: string; example: string; use: string }[];
  typeScale: { name: string; size: string; weight: string; use: string }[];
  spacing: Record<string, string>;
  radii: Record<string, string>;
  fonts: { sans: string; mono: string };
  chrome: string[];
  rules: string[];
};

/** The brand layer as data (for get_design_system and the brand guide). */
export function designSystem(brand: BrandPack): DesignSystem {
  void brand;
  throw new Error('designSystem: not implemented yet (phase 3 item 2)');
}
