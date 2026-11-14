import type { BrandPack } from '@/lib/brand';
import type { DesignSlide, Slide } from '@/lib/slides';
import { brandCss, chromeHtml, codeRows, designLayerCss, esc, foot, H, inline, W } from './brand-layer';
import { ROOT, sanitizeCss, sanitizeHtml } from './sanitize';

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
  if (slide.kind === 'design') return designHtml(slide, i, total, tipLabel, brand);
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

// ---------- design slides ----------

// The slide root's box and stacking are locked: a layer declared first with !important beats any agent
// declaration (layered !important > unlayered !important), so agent css cannot move the slide, let content
// escape its clip, or stack above the studio chrome.
const LOCK = `@layer studio-lock{${ROOT}{position:relative!important;inset:0!important;margin:0!important;width:${W}px!important;height:${H}px!important;overflow:hidden!important;isolation:isolate!important;contain:paint!important;z-index:0!important;transform:none!important;zoom:1!important}}`;

const cssString = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/</g, '\\3c ').replace(/\n/g, '\\a ')}"`;

const decode = (s: string) => s.replace(/&(lt|gt|quot|#39|apos|amp|#x[0-9a-f]+|#\d+);/gi, (m, e: string) => {
  const k = e.toLowerCase();
  if (k[0] === '#') return String.fromCodePoint(Math.min(k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10), 0x10ffff) || 0xfffd);
  return ({ lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'", amp: '&' } as Record<string, string>)[k] ?? m;
});

/** <pre class="editor [diff]">plain code</pre> → highlighted editor rows (like the code template). */
const editorBlocks = (html: string) =>
  html.replace(/<pre\b([^>]*?)\bclass="([^"]*\beditor\b[^"]*)"([^>]*)>([^<]*)<\/pre>/gi, (_, a: string, cls: string, b: string, code: string) =>
    `<div${a}class="${cls}"${b}>${codeRows(decode(code).replace(/^\r?\n/, '').replace(/\r?\n$/, ''), /\bdiff\b/.test(cls))}</div>`);

/**
 * A design slide: brand layer + sanitized html inside <section class="slide design {ground}"> + css scoped to that
 * section + the studio chrome (outside the section, so agent css cannot touch it).
 * The section also gets --tip (the tip label) and --handle as CSS strings, e.g. ".x::before{content:var(--tip)}".
 */
export function designHtml(slide: DesignSlide, i: number, total: number, tipLabel: string, brand: BrandPack) {
  const html = sanitizeHtml(slide.html);
  const css = sanitizeCss([slide.css ?? '', ...html.styles].join('\n'), { scope: true });
  const ground = slide.ground ?? 'paper';
  // Default: no footer. The designer places the handle where it fits (a footer on every slide read as a template).
  const chrome = slide.chrome ?? 'none';
  const cls = `slide design ${ground}${chrome === 'none' ? '' : ' with-foot'}`;
  const vars = `--tip:${cssString(tipLabel)};--handle:${cssString(brand.handle)}`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${LOCK}${brandCss(brand)}${designLayerCss(brand)}</style><style>${css.css}</style></head>`
    + `<body><section class="${cls}" style="${esc(vars)}">${editorBlocks(html.html)}</section>${chromeHtml(chrome, ground, i + 1, total, brand.handle)}</body></html>`;
}

