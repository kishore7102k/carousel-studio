// Phase 3 uploaded assets (images/SVG for design slides). CONTRACT STUBS: Agent B implements (item 7).
export type Asset = { id: string; url: string; kind: string; bytes: number; width: number | null; height: number | null; createdBy: string; createdAt: Date };

export async function uploadAsset(input: { name: string; mimeType: string; base64: string; createdBy: string }): Promise<Asset> {
  void input; throw new Error('uploadAsset: not implemented yet (phase 3 item 7)');
}
export async function listAssets(): Promise<Asset[]> { return []; }
export async function deleteAsset(id: string): Promise<boolean> { void id; return false; }
/** Blob host that design slides may load images from (the renderer's network allow-list). */
export function assetHost(): string | null {
  const t = process.env.BLOB_READ_WRITE_TOKEN;
  const storeId = t?.split('_')[3];
  return storeId ? `${storeId.toLowerCase()}.public.blob.vercel-storage.com` : null;
}
