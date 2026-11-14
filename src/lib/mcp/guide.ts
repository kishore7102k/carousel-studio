import { getBrand } from '@/lib/brand';
import { SLIDE_FORMAT_GUIDE } from '@/lib/slides';

export const WORKFLOW = `Carousel Studio workflow for agents:
1. Call get_brand_guide once per session and follow it (voice, one marked phrase per slide, limits).
2. list_requests shows what the human asked for: "note" = feedback pinned on a slide (slide = 1-based number, x/y as 0-1 fractions of the image), "new" = make a new carousel from the text.
3. claim_request before working on one (another agent may hold it; leases expire after 30 min).
4. Make the change:
   - notes: edit_slide / insert_slide / remove_slide / move_slide for targeted edits, or update_slides with the full array. Every change saves a NEW version and renders it.
   - "new": create_carousel.
   Pass baseVersion (the version you read) on edits; a "stale" error means another agent saved first: re-read with get_carousel and redo the change.
5. Optionally view_slides to check the rendered result.
6. complete_request with a one-line reply and the resulting version. dismiss_request if it should not be done (reopen_request undoes done/dismissed). add_note pins feedback on a slide; request_carousel queues a new-carousel prompt.

Conventions:
- Slide numbers in every tool input and output are 1-based (slide 1 = cover).
- Your API key has scopes: read (look only), write (edit carousels and requests), admin (brand, API keys, permanent delete). A "missing scope" error means ask the human for a key with more access.
- delete_carousel moves a carousel to the trash (restore_carousel undoes it). Only purge_carousel deletes for good, and only from the trash.
- Status (draft → review → approved → posted) belongs to the human; agents normally leave it alone. Edits set it back to review.
- Every write is recorded in the activity log (list_activity) under your key's name.`;

/** Workflow + slide format + active brand README. Same text for the tool, the resource and the prompts. */
export async function brandGuideText() {
  const b = await getBrand();
  return `${WORKFLOW}\n\n# Slide format\n${SLIDE_FORMAT_GUIDE}\n\n# Brand: ${b.name}\nHandle on slides: ${b.handle}. Label: "${b.labelPrefix} 014".\n\n${b.readme}`;
}
