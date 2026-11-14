import { createBlank, requestNewCarousel } from '@/app/actions';

export default function NewCarousel() {
  return (
    <>
      <div className="page-head"><h1>New carousel</h1></div>
      <div className="forms">
        <form action={requestNewCarousel} className="form-card">
          <h2>Ask an agent</h2>
          <p className="muted">Describe the tip. Any connected agent picks it up from the queue, writes the slides and renders them.</p>
          <div>
            <label htmlFor="prompt">Prompt</label>
            <textarea id="prompt" name="prompt" rows={7} required placeholder="Tip about the native <dialog> element replacing modal libraries. Show before/after code. 6 slides." />
          </div>
          <button type="submit" className="btn primary">Send to agents</button>
        </form>
        <form action={createBlank} className="form-card">
          <h2>Write it myself</h2>
          <p className="muted">Starts from the 4-slide template. Edit the text on the next screen; it renders on save.</p>
          <div>
            <label htmlFor="title">Title</label>
            <input id="title" name="title" required placeholder="Native date input" />
          </div>
          <div>
            <label htmlFor="tipNumber">Number (shown on the cover label)</label>
            <input id="tipNumber" name="tipNumber" type="number" min={1} placeholder="14" />
          </div>
          <button type="submit" className="btn">Create from template</button>
        </form>
      </div>
    </>
  );
}
