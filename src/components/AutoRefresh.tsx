'use client';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

/** Refreshes server data every few seconds while agents have work in flight. */
export function AutoRefresh({ active, ms = 8000 }: { active: boolean; ms?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => { if (document.visibilityState === 'visible') router.refresh(); }, ms);
    return () => clearInterval(t);
  }, [active, ms, router]);
  return null;
}
