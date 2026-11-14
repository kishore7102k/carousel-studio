import { notFound } from 'next/navigation';
import { getCarousel, listActivity } from '@/lib/store';
import { CarouselView } from './CarouselView';

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

export default async function CarouselPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ v?: string }> }) {
  const { id } = await params;
  const { v } = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const data = await getCarousel(id, v ? Number(v) : undefined);
  if (!data?.version) notFound();
  const activity = await listActivity({ carouselId: id, limit: 20 });
  return <CarouselView data={JSON.parse(JSON.stringify(data))} activity={JSON.parse(JSON.stringify(activity))} />;
}
