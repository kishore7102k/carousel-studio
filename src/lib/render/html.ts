import type { BrandPack } from '@/lib/brand';
import type { Slide } from '@/lib/slides';
import { brandCss, codeRows, esc, foot, H, inline, W } from './brand-layer';

export { W, H, inline };

// Template layouts (cover, content, code, cta). The brand layer (fonts, role variables, footer, code rows) is in
// brand-layer.ts. Template HTML must stay byte-identical: scripts/render-check.ts --check.
const css = (b: BrandPack) => `${brandCss(b)}${BASE}`;

const BASE = `
*{box-sizing:border-box;margin:0}
html,body{width:${W}px;height:${H}px;overflow:hidden}
body{font-family:var(--sans);-webkit-font-smoothing:antialiased}
.slide{width:${W}px;height:${H}px;padding:96px;display:flex;flex-direction:column}
.primary{background:var(--primary);color:var(--on-primary)}
.paper{background:var(--paper);color:var(--ink)}
.mono{font-family:var(--mono);font-weight:500;font-size:30px;line-height:1.2}
.key{align-self:flex-start;padding:10px 24px;border-radius:12px;border:1px solid color-mix(in srgb,var(--on-primary) 35%,transparent);border-bottom-width:10px}
.hook{margin-top:auto;font-weight:700;font-size:112px;line-height:1;letter-spacing:-0.035em;text-wrap:balance}
.sub{margin-top:24px;font-weight:500;font-size:42px;line-height:1.4;opacity:.82}
.foot{display:flex;justify-content:space-between;align-items:center;margin-top:64px;opacity:.8}
.paper .foot,.paper .top{color:var(--muted);opacity:1}
.dot{display:inline-block;width:16px;height:16px;border-radius:999px;background:var(--bright);margin-right:14px;vertical-align:2px}
.paper .dot{background:var(--accent)}
.top{display:flex;justify-content:space-between}
mark{color:var(--on-marker);background:linear-gradient(var(--marker),var(--marker)) 0 62%/100% 74% no-repeat;padding:0 .1em;-webkit-box-decoration-break:clone;box-decoration-break:clone}
.title{margin-top:64px;font-weight:700;font-size:72px;line-height:1.05;letter-spacing:-0.03em;text-wrap:balance}
ul{list-style:none;padding:0;margin-top:48px}
li{font-weight:500;font-size:42px;line-height:1.4;padding:24px 0;border-top:1px solid var(--line)}
.body{margin-top:48px;font-weight:500;font-size:42px;line-height:1.45}
code{font-family:var(--mono);font-size:.86em;background:var(--code-bg);color:var(--code-text);padding:0 .3em;border-radius:10px}
.editor{margin-top:48px;background:var(--code-bg);border:1px solid var(--code-line);border-radius:32px;padding:40px 0;font-family:var(--mono);font-size:36px;line-height:1.5;color:var(--code-text)}
.r{display:block;white-space:pre;padding:0 40px;min-height:1.5em}
.rm{background:var(--rm);color:var(--cm)} .rm .t{text-decoration:line-through;text-decoration-color:var(--cm)}
.rm .k,.rm .s,.rm .g,.rm .c,.rm .tg{color:var(--cm)}
.add{background:var(--add);box-shadow:inset 16px 0 0 var(--bright)}
.g{color:var(--cm)} .k{color:var(--kw)} .s{color:var(--str)} .tg{color:var(--tag)} .c{color:var(--cm)}
.caption{margin-top:auto;font-weight:700;font-size:64px;line-height:1.08;letter-spacing:-0.03em;text-wrap:balance}
`;

export function slideHtml(slide: Slide, i: number, total: number, tipLabel: string, brand: BrandPack) {
  const counter = `${i + 1} / ${total}`;
  let inner: string;
  switch (slide.kind) {
    case 'cover':
    case 'cta':
      inner = `<section class="slide primary">
        <span class="key mono">${esc(('label' in slide && slide.label) || tipLabel)}</span>
        <h1 class="hook">${inline(slide.hook)}</h1>
        ${slide.sub ? `<p class="sub">${inline(slide.sub)}</p>` : ''}
        ${foot(counter, brand.handle)}
      </section>`;
      break;
    case 'content':
      inner = `<section class="slide paper">
        <div class="top mono"><span>${esc(tipLabel)}</span><span>${counter}</span></div>
        <h2 class="title">${inline(slide.title)}</h2>
        ${slide.points?.length ? `<ul>${slide.points.map(p => `<li>${inline(p)}</li>`).join('')}</ul>` : ''}
        ${slide.body ? `<p class="body">${inline(slide.body)}</p>` : ''}
        <div style="margin-top:auto">${foot('Swipe', brand.handle)}</div>
      </section>`;
      break;
    case 'code':
      inner = `<section class="slide paper">
        <div class="top mono"><span>${esc(slide.file || tipLabel)}</span><span>${counter}</span></div>
        <div class="editor">${codeRows(slide.code, !!slide.diff)}</div>
        ${slide.caption ? `<p class="caption">${inline(slide.caption)}</p>` : ''}
      </section>`;
      break;
  }
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css(brand)}</style></head><body>${inner}</body></html>`;
}
