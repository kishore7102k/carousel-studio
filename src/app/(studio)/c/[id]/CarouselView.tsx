'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition, type MouseEvent } from 'react';
import type { Slide } from '@/lib/slides';
import { addNote, deleteCarousel, dismissRequest, rerender, saveSlides, setStatus, switchVersion } from '@/app/actions';
import { AutoRefresh } from '@/components/AutoRefresh';

type Req = { id: string; kind: string; status: string; text: string; slideIndex: number | null; x: number | null; y: number | null; versionNumber: number | null; claimedBy: string | null; reply: string | null; resultVersion: number | null };
type Data = {
  carousel: { id: string; title: string; status: string; currentVersion: number; tipNumber: number | null };
  version: { number: number; slides: Slide[]; images: string[]; createdBy: string; note: string | null };
  versions: { number: number; createdBy: string; note: string | null; createdAt: string }[];
  requests: Req[];
};

const blank: Record<Slide['kind'], Slide> = {
  cover: { kind: 'cover', hook: 'New *hook*' },
  content: { kind: 'content', title: 'New *title*', points: ['Point one', 'Point two'] },
  code: { kind: 'code', file: 'example.ts', code: 'const x = 1;' },
  cta: { kind: 'cta', hook: 'Save this for *later*.' },
};

export function CarouselView({ data }: { data: Data }) {
  const router = useRouter();
  const { carousel, version, versions, requests } = data;
  const [draftPin, setDraftPin] = useState<{ slide: number; x: number; y: number } | null>(null);
  const [noteText, setNoteText] = useState('');
  const [editing, setEditing] = useState<Slide[] | null>(null);
  const [editNote, setEditNote] = useState('');
  const [error, setError] = useState('');
  const [pending, start] = useTransition();
  const isCurrent = version.number === carousel.currentVersion;
  const active = requests.filter(r => r.status === 'open' || r.status === 'claimed');
  const slides = editing ?? version.slides;

  function pinAt(e: MouseEvent<HTMLDivElement>, slide: number) {
    if ((e.target as HTMLElement).closest('.popover')) return;
    const box = e.currentTarget.getBoundingClientRect();
    setDraftPin({ slide, x: (e.clientX - box.left) / box.width, y: (e.clientY - box.top) / box.height });
    setNoteText('');
  }

  function submitNote() {
    if (!draftPin || !noteText.trim()) return;
    const pin = draftPin;
    start(async () => {
      await addNote({ carouselId: carousel.id, versionNumber: version.number, slideIndex: pin.slide, x: pin.x, y: pin.y, text: noteText });
      setDraftPin(null);
      router.refresh();
    });
  }

  function patch(i: number, next: Partial<Slide>) {
    setEditing(s => (s ?? version.slides).map((sl, j) => (j === i ? ({ ...sl, ...next } as Slide) : sl)));
  }

  function save() {
    if (!editing) return;
    setError('');
    start(async () => {
      const res = await saveSlides(carousel.id, editing, editNote);
      if ('error' in res && res.error) { setError(res.error); return; }
      setEditing(null);
      setEditNote('');
      router.push(`/c/${carousel.id}`);
      router.refresh();
    });
  }

  const pinsFor = (i: number) => requests.filter(r => r.kind === 'note' && r.slideIndex === i && r.versionNumber === version.number && r.status !== 'dismissed');

  return (
    <>
      <AutoRefresh active={active.length > 0} />
      <div className="page-head">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Link href="/" className="muted">← Carousels</Link>
          <h1>{carousel.title}</h1>
          <span className="row">
            <span className={`chip ${carousel.status}`}>{carousel.status}</span>
            {carousel.tipNumber && <span className="chip">#{String(carousel.tipNumber).padStart(3, '0')}</span>}
            <span className="chip">v{version.number} by {version.createdBy}{isCurrent ? '' : ' · not current'}</span>
            {version.note && <span className="muted">{version.note}</span>}
          </span>
        </div>
        <div className="row">
          <label htmlFor="version" className="sr-only" style={{ margin: 0 }}>Version</label>
          <select id="version" value={version.number} onChange={e => router.push(`/c/${carousel.id}?v=${e.target.value}`)} style={{ width: 'auto' }}>
            {versions.map(v => <option key={v.number} value={v.number}>v{v.number} · {v.createdBy}{v.number === carousel.currentVersion ? ' (current)' : ''}</option>)}
          </select>
          {!isCurrent && <button className="btn" disabled={pending} onClick={() => start(async () => { await switchVersion(carousel.id, version.number); router.refresh(); })}>Use this version</button>}
          {carousel.status !== 'approved' && carousel.status !== 'posted'
            ? <button className="btn primary" disabled={pending} onClick={() => start(() => setStatus(carousel.id, 'approved'))}>Approve</button>
            : <button className="btn" disabled={pending} onClick={() => start(() => setStatus(carousel.id, carousel.status === 'approved' ? 'posted' : 'review'))}>{carousel.status === 'approved' ? 'Mark posted' : 'Back to review'}</button>}
        </div>
      </div>

      <div className="cv">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <p className="muted">Click anywhere on a slide to pin a note for the agents. {editing ? 'Editing text: changes save as a new version.' : ''}</p>
          <div className="slides">
            {slides.map((s, i) => (
              <div key={i} className="slide">
                <div className="slide-img" onClick={e => !editing && pinAt(e, i)} role="button" tabIndex={0} aria-label={`Slide ${i + 1}, click to pin a note`}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {version.images[i] && !editing ? <img src={version.images[i]} alt={`Slide ${i + 1}`} draggable={false} /> : <span className="missing">{editing ? 'Preview renders on save' : 'Not rendered'}</span>}
                  {!editing && pinsFor(i).map((r, n) => (
                    <span key={r.id} className={`pin ${r.status === 'done' ? 'done' : ''}`} style={{ left: `${(r.x ?? 0) * 100}%`, top: `${(r.y ?? 0) * 100}%` }} title={r.text}>{n + 1}</span>
                  ))}
                  {draftPin?.slide === i && (
                    <>
                      <span className="pin draft" style={{ left: `${draftPin.x * 100}%`, top: `${draftPin.y * 100}%` }}>+</span>
                      <div className="popover" style={{ left: `min(${draftPin.x * 100}%, calc(100% - 260px))`, top: `min(calc(${draftPin.y * 100}% + 18px), calc(100% - 150px))` }}>
                        <textarea autoFocus rows={3} value={noteText} onChange={e => setNoteText(e.target.value)} placeholder="What should change here?" aria-label="Note" />
                        <div className="row">
                          <button className="btn primary sm" disabled={pending || !noteText.trim()} onClick={submitNote}>Add note</button>
                          <button className="btn sm" onClick={() => setDraftPin(null)}>Cancel</button>
                        </div>
                      </div>
                    </>
                  )}
                </div>
                <div className="slide-meta">
                  <span className="mono muted">{i + 1} · {s.kind}</span>
                  {version.images[i] && !editing && <a href={version.images[i]} target="_blank" rel="noreferrer" className="muted">Open PNG</a>}
                </div>
                {editing && <SlideEditor slide={s} onChange={p => patch(i, p)} onRemove={() => setEditing(editing.filter((_, j) => j !== i))} />}
              </div>
            ))}
          </div>
          {editing ? (
            <div className="savebar">
              <select aria-label="Add slide" value="" onChange={e => { const k = e.target.value as Slide['kind']; if (k) setEditing([...editing.slice(0, -1), blank[k], ...editing.slice(-1)]); }} style={{ width: 'auto' }}>
                <option value="">+ Add slide…</option>
                <option value="content">Content</option>
                <option value="code">Code</option>
                <option value="cover">Cover</option>
                <option value="cta">CTA</option>
              </select>
              <input aria-label="What changed" placeholder="What changed (optional)" value={editNote} onChange={e => setEditNote(e.target.value)} style={{ flex: 1, minWidth: 180 }} />
              <button className="btn primary" disabled={pending} onClick={save}>{pending ? 'Rendering…' : 'Save as new version'}</button>
              <button className="btn" disabled={pending} onClick={() => { setEditing(null); setError(''); }}>Cancel</button>
              {error && <p className="error" role="alert">{error}</p>}
            </div>
          ) : (
            <div className="row">
              <button className="btn" onClick={() => setEditing(structuredClone(version.slides))}>Edit text</button>
              <button className="btn" disabled={pending} onClick={() => start(async () => { await rerender(carousel.id, version.number); router.refresh(); })}>{pending ? 'Working…' : 'Re-render'}</button>
              <button className="btn danger" disabled={pending} onClick={() => { if (window.confirm(`Delete "${carousel.title}" and all its versions?`)) start(() => deleteCarousel(carousel.id)); }}>Delete</button>
            </div>
          )}
        </div>

        <aside className="panel" aria-label="Notes and requests">
          <h2>Notes for agents</h2>
          {requests.filter(r => r.status !== 'dismissed').length === 0 && <p className="muted">No notes yet. Click a slide to add one.</p>}
          {requests.filter(r => r.status !== 'dismissed').map(r => (
            <div key={r.id} className="req">
              <span className="row">
                <span className={`chip ${r.status}`}>{r.status}{r.claimedBy ? ` · ${r.claimedBy}` : ''}</span>
                {r.slideIndex !== null && <span className="chip">slide {r.slideIndex + 1} · v{r.versionNumber}</span>}
              </span>
              <p>{r.text}</p>
              {r.reply && <p className="reply">{r.reply}{r.resultVersion ? <> · <Link href={`/c/${carousel.id}?v=${r.resultVersion}`}>see v{r.resultVersion}</Link></> : null}</p>}
              {r.status === 'open' && <button className="btn sm" disabled={pending} onClick={() => start(() => dismissRequest(r.id, carousel.id))}>Dismiss</button>}
            </div>
          ))}
        </aside>
      </div>
    </>
  );
}

function SlideEditor({ slide, onChange, onRemove }: { slide: Slide; onChange: (p: Partial<Slide>) => void; onRemove: () => void }) {
  const field = (key: string, label: string, value: string | undefined, rows = 2, code = false) => (
    <div>
      <label>{label}</label>
      <textarea rows={rows} className={code ? 'code' : undefined} value={value ?? ''} onChange={e => onChange({ [key]: e.target.value || undefined } as Partial<Slide>)} />
    </div>
  );
  return (
    <div className="editor">
      {(slide.kind === 'cover' || slide.kind === 'cta') && <>
        {slide.kind === 'cover' && field('label', 'Label (default: tip number)', slide.label, 1)}
        {field('hook', 'Hook (*marked phrase*)', slide.hook, 3)}
        {field('sub', 'Sub line', slide.sub)}
      </>}
      {slide.kind === 'content' && <>
        {field('title', 'Title', slide.title)}
        <div>
          <label>Points (one per line)</label>
          <textarea rows={4} value={(slide.points ?? []).join('\n')} onChange={e => onChange({ points: e.target.value ? e.target.value.split('\n') : undefined } as Partial<Slide>)} />
        </div>
        {field('body', 'Or a paragraph', slide.body, 3)}
      </>}
      {slide.kind === 'code' && <>
        {field('file', 'Filename', slide.file, 1)}
        {field('code', 'Code (diff: start lines with "- " or "+ ")', slide.code, 7, true)}
        <label style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="checkbox" checked={!!slide.diff} onChange={e => onChange({ diff: e.target.checked } as Partial<Slide>)} style={{ width: 'auto' }} /> Show as diff
        </label>
        {field('caption', 'Caption', slide.caption)}
      </>}
      <button className="btn sm danger" onClick={onRemove}>Remove slide</button>
    </div>
  );
}
