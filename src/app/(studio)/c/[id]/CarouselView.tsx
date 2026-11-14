'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition, type MouseEvent } from 'react';
import type { DesignSlide, Slide as TemplateSlide } from '@/lib/slides';
import { addNote, convertToDesign, deleteCarousel, dismissRequest, duplicateCarousel, previewDesign, rerender, saveSlides, setStatus, switchVersion } from '@/app/actions';
import { AutoRefresh } from '@/components/AutoRefresh';
import { LocalTime } from '@/components/LocalTime';

type Slide = TemplateSlide | DesignSlide;
type LintItem = { errors: string[]; warnings: string[] } | null;
type Req = { id: string; kind: string; status: string; text: string; slideIndex: number | null; x: number | null; y: number | null; versionNumber: number | null; claimedBy: string | null; reply: string | null; resultVersion: number | null };
type Data = {
  carousel: { id: string; title: string; status: string; currentVersion: number; tipNumber: number | null };
  version: { number: number; slides: Slide[]; images: string[]; lint?: LintItem[] | null; createdBy: string; note: string | null };
  versions: { number: number; createdBy: string; note: string | null; createdAt: string }[];
  requests: Req[];
};

const DESIGN_STARTER: DesignSlide = {
  kind: 'design',
  name: 'big number',
  html: '<div class="stat">\n  <span class="key">Tip</span>\n  <div class="num">10<span class="unit">x</span></div>\n  <h2>Faster with <span class="mark">one change</span></h2>\n  <p>Explain the number in one short line.</p>\n</div>',
  css: '.stat { position: absolute; inset: 64px; display: flex; flex-direction: column; justify-content: center; gap: 24px; }\n.num { font-size: 360px; line-height: 1; font-weight: 700; color: var(--primary); }\n.unit { font-size: 160px; }\nh2 { font-size: 72px; line-height: 1.1; margin: 0; color: var(--ink); }\np { font-size: 36px; color: var(--ink); margin: 0; }',
  chrome: 'none',
};

// Templates were removed: new slides are always designed (blank canvas).
const blank: Record<string, Slide> = { design: DESIGN_STARTER };

type Act = { id: string; actor: string; action: string; createdAt: string };

export function CarouselView({ data, activity }: { data: Data; activity: Act[] }) {
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
      const res = await saveSlides(carousel.id, editing as TemplateSlide[], editNote);
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
                  <span className="mono muted">{i + 1} · {s.kind}{s.kind === 'design' && s.name ? ` · ${s.name}` : ''}</span>
                  {!editing && <LintBadge lint={version.lint?.[i] ?? null} />}
                  {version.images[i] && !editing && <a href={version.images[i]} target="_blank" rel="noreferrer" className="muted">Open PNG</a>}
                </div>
                {editing && <SlideEditor slide={s} carouselId={carousel.id} index={i} total={slides.length} onReplace={ns => setEditing(editing.map((x, j) => (j === i ? ns : x)))} onChange={p => patch(i, p)} onRemove={() => setEditing(editing.filter((_, j) => j !== i))} />}
              </div>
            ))}
          </div>
          {editing ? (
            <div className="savebar">
              <select aria-label="Add slide" value="" onChange={e => { const k = e.target.value; if (k) setEditing([...editing.slice(0, -1), structuredClone(blank[k]), ...editing.slice(-1)]); }} style={{ width: 'auto' }}>
                <option value="">+ Add slide…</option>
                <option value="design">Blank design slide</option>
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
              <button className="btn danger" disabled={pending} onClick={() => { if (window.confirm(`Move "${carousel.title}" to trash?`)) start(() => deleteCarousel(carousel.id)); }}>Delete</button>
              <button className="btn" disabled={pending} onClick={() => start(() => duplicateCarousel(carousel.id))}>Duplicate</button>
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
          <h2 style={{ marginTop: 24 }}>Activity</h2>
          {activity.length === 0 && <p className="muted">Nothing logged yet.</p>}
          {activity.map(a => (
            <p key={a.id} className="muted" style={{ margin: '4px 0', fontSize: 13 }}>
              <b>{a.actor}</b> {a.action.replace(/_/g, ' ')} · <LocalTime value={a.createdAt} />
            </p>
          ))}
        </aside>
      </div>
    </>
  );
}

function LintBadge({ lint }: { lint: LintItem }) {
  if (!lint || (lint.errors.length === 0 && lint.warnings.length === 0)) return null;
  const n = lint.errors.length + lint.warnings.length;
  return (
    <details className="lint-badge">
      <summary className={`chip ${lint.errors.length ? 'error' : ''}`} title={[...lint.errors, ...lint.warnings].join('\n')}>{n} {lint.errors.length ? 'issue' : 'warning'}{n > 1 ? 's' : ''}</summary>
      <ul>{lint.errors.map((m, i) => <li key={`e${i}`}><b>error</b> {m}</li>)}{lint.warnings.map((m, i) => <li key={`w${i}`}>{m}</li>)}</ul>
    </details>
  );
}

type Preview = { dataUrl: string | null; errors: string[]; warnings: string[] };

function DesignEditor({ slide, carouselId, index, total, onChange }: { slide: DesignSlide; carouselId: string; index: number; total: number; onChange: (p: Partial<DesignSlide>) => void }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, go] = useTransition();
  const set = (key: 'name' | 'css' | 'chrome', value: string) => onChange({ [key]: value === '' ? undefined : value } as Partial<DesignSlide>);
  return (
    <div className="design-edit">
      <div className="design-fields">
        <div><label>Name</label><input value={slide.name ?? ''} onChange={e => set('name', e.target.value)} placeholder="e.g. big number" /></div>
        <div>
          <label>Chrome</label>
          <select value={slide.chrome ?? 'auto'} onChange={e => set('chrome', e.target.value)}>
            <option value="auto">auto (handle + counter)</option>
            <option value="handle">handle</option>
            <option value="counter">counter</option>
            <option value="none">none</option>
          </select>
        </div>
        <div><label>HTML</label><textarea rows={10} className="code" spellCheck={false} value={slide.html} onChange={e => onChange({ html: e.target.value })} /></div>
        <div><label>CSS</label><textarea rows={8} className="code" spellCheck={false} value={slide.css ?? ''} onChange={e => set('css', e.target.value)} /></div>
        <button className="btn sm primary" disabled={busy} onClick={() => go(async () => setPreview(await previewDesign(carouselId, slide, index + 1, total)))}>{busy ? 'Rendering…' : 'Preview'}</button>
      </div>
      {preview && (
        <div className="design-preview">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          {preview.dataUrl && <img src={preview.dataUrl} alt="Design preview" />}
          {preview.errors.length > 0 && <ul className="error" role="alert">{preview.errors.map((m, i) => <li key={i}>{m}</li>)}</ul>}
          {preview.warnings.length > 0 && <ul className="muted">{preview.warnings.map((m, i) => <li key={i}>{m}</li>)}</ul>}
          {preview.dataUrl && preview.errors.length === 0 && preview.warnings.length === 0 && <p className="muted">No issues.</p>}
        </div>
      )}
    </div>
  );
}

function SlideEditor({ slide, carouselId, index, total, onReplace, onChange, onRemove }: { slide: Slide; carouselId: string; index: number; total: number; onReplace: (s: Slide) => void; onChange: (p: Partial<Slide>) => void; onRemove: () => void }) {
  const [convErr, setConvErr] = useState('');
  const [converting, conv] = useTransition();
  if (slide.kind === 'design') {
    return (
      <div className="editor">
        <DesignEditor slide={slide} carouselId={carouselId} index={index} total={total} onChange={p => onChange(p as Partial<Slide>)} />
        <button className="btn sm danger" onClick={onRemove}>Remove slide</button>
      </div>
    );
  }
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
      <span className="row">
        <button className="btn sm" disabled={converting} onClick={() => conv(async () => {
          const r = await convertToDesign(carouselId, slide, index, total);
          if ('error' in r) setConvErr(r.error); else onReplace(r.slide);
        })}>{converting ? 'Converting…' : 'Convert to design'}</button>
        <button className="btn sm danger" onClick={onRemove}>Remove slide</button>
      </span>
      {convErr && <p className="error" role="alert">{convErr}</p>}
    </div>
  );
}
