// Sanitizer for agent-designed slides (no dependencies). Defense in depth: the renderer ALSO runs with JavaScript off,
// all network blocked except data: and the asset host, and a strict CSP, so this pass is about storing clean HTML/CSS
// and giving the agent clear feedback, not the only line of defense.
//
// HTML: a tokenizer re-serializes every tag from parsed attributes (normalized quoting), escapes stray "<" in text,
// drops dangerous elements/attributes/URLs and closes what the fragment opened (it can never close the slide root).
// CSS: escapes are normalized (so "u\72l(" is seen as "url("), comments stripped, "<" escaped (no "</style>"),
// a block parser drops @import/@charset/@namespace/@font-face/unknown at-rules and remote url()/image-set() URLs,
// and (when scoping) prefixes every selector with the slide root.
import { assetHost } from '@/lib/assets';

export type Removed = string[];

// ---------- URLs ----------

/** Allowed: #fragment, data:image/*, https://<asset host>/... Everything else is "remote". */
export function urlAllowed(raw: string): boolean {
  // Browsers strip leading/trailing C0 controls + spaces and remove tabs/newlines inside URLs.
  const v = raw.replace(/^[\u0000- ]+|[\u0000- ]+$/g, '').replace(/[\t\n\r]/g, '');
  if (v.startsWith('#')) return true;
  if (/^data:image\/[a-z0-9.+-]+[;,]/i.test(v)) return true;
  const host = assetHost();
  return !!host && v.toLowerCase().startsWith(`https://${host}/`);
}

const short = (s: string) => (s.length > 60 ? `${s.slice(0, 57)}...` : s);
const describeUrl = (u: string) => (/^\s*(javascript|vbscript):/i.test(u) ? `${u.trim().split(':')[0].toLowerCase()}: URL` : `remote URL ${short(u.trim())}`);

// ---------- HTML entities ----------

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', colon: ':', tab: '\t', newline: '\n', lpar: '(', rpar: ')',
  sol: '/', bsol: '\\', period: '.', comma: ',', semi: ';', equals: '=', excl: '!', num: '#', percnt: '%', plus: '+',
  lsqb: '[', rsqb: ']', lcub: '{', rcub: '}', grave: '`', ast: '*', dollar: '$', quest: '?', commat: '@', hyphen: '-', dash: '-',
};

/** Decodes entities; `ok` is false if a named entity is unknown (the caller then drops the value). */
function decodeEntities(s: string): { text: string; ok: boolean } {
  let ok = true;
  const text = s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);?/gi, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '�';
    }
    const v = NAMED[e.toLowerCase()];
    if (v !== undefined && (m.endsWith(';') || ['amp', 'lt', 'gt', 'quot', 'nbsp'].includes(e.toLowerCase()))) return v;
    if (m.endsWith(';')) ok = false; // unknown named entity: we cannot be sure what the browser sees
    return m;
  });
  return { text, ok };
}

// ---------- HTML ----------

/** Removed with everything inside them. Raw-text elements are skipped to their end tag. */
const DROP_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'frame', 'frameset', 'object', 'applet', 'noembed', 'noframes', 'xmp', 'plaintext', 'title', 'textarea', 'template', 'portal', 'fencedframe', 'head']);
/** Raw text in the HTML parser: their content is not markup, so skip to the matching end tag. */
const RAW_TEXT = new Set(['script', 'style', 'iframe', 'noembed', 'noframes', 'xmp', 'plaintext', 'title', 'textarea']);
/** The tag is removed, its children are kept. */
const DROP_TAG = new Set(['link', 'meta', 'base', 'embed', 'form', 'html', 'body', 'animate', 'set', 'animatemotion', 'animatetransform', 'discard', 'handler', 'listener']);
/** Reported when removed (security-relevant), others are removed silently. */
const REPORT_TAG = new Set(['script', 'iframe', 'frame', 'frameset', 'object', 'applet', 'embed', 'link', 'meta', 'base', 'form', 'portal', 'fencedframe', 'animate', 'set', 'animatemotion', 'animatetransform', 'handler', 'listener']);
const VOID = new Set(['area', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr', 'param', 'keygen', 'base']);
const URL_ATTRS = new Set(['href', 'xlink:href', 'src', 'poster', 'background', 'action', 'formaction', 'data', 'cite', 'longdesc', 'lowsrc', 'dynsrc', 'codebase', 'manifest', 'icon', 'profile', 'usemap', 'archive', 'classid', 'itemtype']);
const DROP_ATTRS = new Set(['srcdoc', 'formaction', 'action', 'ping', 'http-equiv', 'attributename', 'imagesrcset', 'nonce']);

type Attr = { name: string; value: string | null };

/** Parses attributes starting at i (just after the tag name). Returns them and the index after ">". */
function parseAttrs(s: string, i: number): { attrs: Attr[]; end: number; selfClosing: boolean } {
  const attrs: Attr[] = [];
  let selfClosing = false;
  while (i < s.length) {
    while (i < s.length && /[\s/]/.test(s[i])) { if (s[i] === '/') selfClosing = s[i + 1] === '>'; i++; }
    if (i >= s.length) break;
    if (s[i] === '>') return { attrs, end: i + 1, selfClosing };
    selfClosing = false;
    let j = i + 1; // an attribute name may start with "=" in HTML, never mind: it is invalid and dropped below
    while (j < s.length && !/[\s/>=]/.test(s[j])) j++;
    const name = s.slice(i, j);
    i = j;
    while (i < s.length && /\s/.test(s[i])) i++;
    if (s[i] !== '=') { attrs.push({ name, value: null }); continue; }
    i++;
    while (i < s.length && /\s/.test(s[i])) i++;
    let value: string;
    if (s[i] === '"' || s[i] === "'") {
      const q = s[i];
      const close = s.indexOf(q, i + 1);
      value = s.slice(i + 1, close < 0 ? s.length : close);
      i = close < 0 ? s.length : close + 1;
    } else {
      j = i;
      while (j < s.length && !/[\s>]/.test(s[j])) j++;
      value = s.slice(i, j);
      i = j;
    }
    attrs.push({ name, value });
  }
  return { attrs, end: s.length, selfClosing };
}

// The browser's tag name runs to whitespace, "/" or ">"; names with other characters are dropped (children kept).
const TAG_NAME = /^[a-zA-Z][^\s/>]*/;
const VALID_TAG = /^[a-zA-Z][a-zA-Z0-9-]*$/;
/** Attributes parsed as CSS (SVG presentation attributes can hold url()). */
const CSS_ATTRS = new Set(['style', 'fill', 'stroke', 'filter', 'clip-path', 'mask', 'marker', 'marker-start', 'marker-mid', 'marker-end', 'cursor']);
const ATTR_NAME = /^[a-zA-Z_:][a-zA-Z0-9_:.-]*$/;

function cleanAttr(tag: string, a: Attr, removed: Removed): string | null {
  const n = a.name.toLowerCase();
  if (!ATTR_NAME.test(a.name)) return null;
  if (n.startsWith('on')) { removed.push(`${n} attribute on <${tag}>`); return null; }
  if (DROP_ATTRS.has(n)) { removed.push(`${n} attribute on <${tag}>`); return null; }
  if (a.value === null) return a.name;
  const raw = a.value;
  const { text, ok } = decodeEntities(raw);
  const out = (v: string) => `${a.name}="${v.replace(/"/g, '&quot;')}"`;
  if (URL_ATTRS.has(n) || n.endsWith(':href')) {
    if (!ok || !urlAllowed(text)) { removed.push(`${describeUrl(text)} in ${n} on <${tag}>`); return null; }
    return out(raw);
  }
  if (n === 'srcset') {
    const bad = text.split(',').map(c => c.trim().split(/\s+/)[0]).filter(u => u && !urlAllowed(u));
    if (!ok || bad.length) { removed.push(`${describeUrl(bad[0] ?? text)} in srcset on <${tag}>`); return null; }
    return out(raw);
  }
  if (CSS_ATTRS.has(n)) {
    // Inline styles and SVG presentation attributes (fill="url(...)") are CSS: sanitize the decoded value.
    if (!ok) { removed.push(`${n} attribute on <${tag}> (undecodable entity)`); return null; }
    const where = `${n} on <${tag}>`;
    const css = n === 'style' ? cleanDeclarations(normalizeCss(text), removed, where) : cleanValue(normalizeCss(text), removed, where);
    return out(css.replace(/&/g, '&amp;'));
  }
  return out(raw);
}

/** Sanitizes agent HTML. `<style>` blocks are moved out and returned in `styles`. */
export function sanitizeHtml(input: string): { html: string; styles: string[]; removed: Removed } {
  const s = input.replace(/\u0000/g, '');
  const removed: Removed = [];
  const styles: string[] = [];
  const stack: string[] = [];
  let out = '';
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt < 0) { out += s.slice(i); break; }
    out += s.slice(i, lt);
    i = lt;
    if (s.startsWith('<!--', i)) { // comment: dropped
      const e = s.indexOf('-->', i + 4);
      i = e < 0 ? s.length : e + 3;
      continue;
    }
    if (s[i + 1] === '!' || s[i + 1] === '?') { // doctype, CDATA, processing instruction, bogus comment: dropped
      const e = s.indexOf('>', i);
      i = e < 0 ? s.length : e + 1;
      continue;
    }
    if (s[i + 1] === '/' && /[a-zA-Z]/.test(s[i + 2] ?? '')) { // end tag
      const m = TAG_NAME.exec(s.slice(i + 2))!;
      const name = m[0];
      const e = s.indexOf('>', i);
      i = e < 0 ? s.length : e + 1;
      const lname = name.toLowerCase();
      const at = stack.lastIndexOf(lname);
      if (at < 0 || DROP_TAG.has(lname) || !VALID_TAG.test(name)) continue; // never close what the fragment did not open (e.g. the slide root)
      // The browser pops everything above the matching element; mirror it.
      out += stack.slice(at + 1).reverse().map(t => `</${t}>`).join('') + `</${name}>`;
      stack.length = at;
      continue;
    }
    const m = TAG_NAME.exec(s.slice(i + 1));
    if (!m) { out += '&lt;'; i++; continue; } // a "<" that does not start a tag is text
    const name = m[0];
    const lname = name.toLowerCase();
    const { attrs, end, selfClosing } = parseAttrs(s, i + 1 + name.length);
    i = end;
    if (DROP_WITH_CONTENT.has(lname)) {
      let content = '';
      if (RAW_TEXT.has(lname) || !selfClosing) {
        const re = new RegExp(`</${lname}[\\s/>]`, 'i');
        const rest = s.slice(i);
        const mm = re.exec(rest);
        content = mm ? rest.slice(0, mm.index) : rest;
        if (mm) { const e = s.indexOf('>', i + mm.index); i = e < 0 ? s.length : e + 1; } else i = s.length;
      }
      if (lname === 'style') styles.push(content);
      else if (REPORT_TAG.has(lname)) removed.push(`<${lname}>`);
      continue;
    }
    if (DROP_TAG.has(lname)) { if (REPORT_TAG.has(lname)) removed.push(`<${lname}>`); continue; }
    if (!VALID_TAG.test(name)) continue;
    const seen = new Set<string>();
    const kept: string[] = [];
    for (const a of attrs) {
      const key = a.name.toLowerCase();
      if (seen.has(key)) continue; // the browser keeps the first one
      seen.add(key);
      const c = cleanAttr(lname, a, removed);
      if (c) kept.push(c);
    }
    const foreign = stack.includes('svg') || stack.includes('math') || lname === 'svg' || lname === 'math';
    const closes = VOID.has(lname) || (selfClosing && foreign);
    out += `<${name}${kept.length ? ' ' + kept.join(' ') : ''}${selfClosing && foreign ? ' /' : ''}>`;
    if (!closes) stack.push(lname);
  }
  out += stack.reverse().map(t => `</${t}>`).join('');
  return { html: out, styles, removed };
}

// ---------- CSS ----------

/** Strips comments, resolves escapes that spell identifier characters (u\72l → url), escapes "<" everywhere. */
export function normalizeCss(css: string): string {
  const s = css.replace(/\u0000/g, '');
  let out = '';
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '/' && s[i + 1] === '*') { const e = s.indexOf('*/', i + 2); i = e < 0 ? s.length : e + 2; out += ' '; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let str = c;
      while (j < s.length && s[j] !== c && s[j] !== '\n') {
        if (s[j] === '\\' && j + 1 < s.length) { str += s[j] + s[j + 1]; j += 2; continue; }
        str += s[j] === '<' ? '\\3c ' : s[j];
        j++;
      }
      out += str + c; // unterminated strings get closed
      i = s[j] === c ? j + 1 : j;
      continue;
    }
    if (c === '\\') {
      const hex = /^[0-9a-fA-F]{1,6}[ \t\n]?/.exec(s.slice(i + 1, i + 8));
      let ch: string;
      let len: number;
      if (hex) { const cp = parseInt(hex[0], 16); ch = cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '�'; len = 1 + hex[0].length; }
      else if (i + 1 < s.length && s[i + 1] !== '\n') { ch = s[i + 1]; len = 2; }
      else { i++; continue; }
      out += /[a-zA-Z0-9_-]/.test(ch) ? ch : s.slice(i, i + len).replace('<', '3c ');
      i += len;
      continue;
    }
    out += c === '<' ? '\\3c ' : c;
    i++;
  }
  return out;
}

/** Index of the matching close for the open bracket at `i` (skipping strings), or -1. */
function matchClose(s: string, i: number): number {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
  const want: string[] = [];
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '"' || c === "'") { j = skipString(s, j); continue; }
    if (pairs[c]) want.push(pairs[c]);
    else if (c === want[want.length - 1]) { want.pop(); if (!want.length) return j; }
  }
  return -1;
}
function skipString(s: string, i: number): number {
  const q = s[i];
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === '\\') { j++; continue; }
    if (s[j] === q || s[j] === '\n') return j;
  }
  return s.length;
}
/** Reads up to the first top-level char in `stops` (outside strings and brackets). */
function readUntil(s: string, i: number, stops: string): number {
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (stops.includes(c)) return j;
    if (c === '"' || c === "'") { j = skipString(s, j); continue; }
    if (c === '(' || c === '[') { const e = matchClose(s, j); if (e < 0) return s.length; j = e; }
  }
  return s.length;
}

function cssString(lit: string): string {
  return lit.slice(1, -1).replace(/\\([0-9a-fA-F]{1,6}[ \t\n]?|[\s\S])/g, (_, e: string) =>
    /^[0-9a-fA-F]/.test(e) ? String.fromCodePoint(Math.min(parseInt(e, 16), 0x10ffff) || 0xfffd) : e === '\n' ? '' : e);
}

const URL_FN = /^(url|src)$/i;
const IMAGESET_FN = /^(-webkit-)?image-set$|^image$|^cross-fade$/i;

/** Replaces disallowed URLs in a CSS value: url(x) / src("x") → none, strings inside image-set() → "". */
export function cleanValue(v: string, removed: Removed, where: string): string {
  let out = '';
  let i = 0;
  while (i < v.length) {
    const c = v[i];
    if (c === '"' || c === "'") { const e = skipString(v, i); out += v.slice(i, e + 1); i = e + 1; continue; }
    const fn = /^([a-zA-Z_-][a-zA-Z0-9_-]*)\(/.exec(v.slice(i));
    if (fn && (i === 0 || !/[a-zA-Z0-9_-]/.test(v[i - 1]))) {
      const name = fn[1];
      const open = i + name.length;
      const close = matchClose(v, open);
      const end = close < 0 ? v.length : close;
      const args = v.slice(open + 1, end);
      if (/^expression$/i.test(name)) { removed.push(`expression() in ${where}`); out += 'none'; i = end + 1; continue; }
      if (URL_FN.test(name)) {
        const a = args.trim();
        const url = /^["']/.test(a) ? cssString(a.slice(0, skipString(a, 0) + 1)) : a;
        if (!urlAllowed(url)) { removed.push(`${describeUrl(url)} in ${where}`); out += 'none'; i = end + 1; continue; }
        out += v.slice(i, end + 1);
        i = end + 1;
        continue;
      }
      if (IMAGESET_FN.test(name)) {
        // Strings inside are URLs.
        const inner = args.replace(/"(?:\\[\s\S]|[^"\\\n])*"?|'(?:\\[\s\S]|[^'\\\n])*'?/g, lit => {
          const u = cssString(lit.length > 1 && lit.endsWith(lit[0]) ? lit : lit + lit[0]);
          if (urlAllowed(u)) return lit;
          removed.push(`${describeUrl(u)} in ${where}`);
          return '""';
        });
        out += `${name}(${cleanValue(inner, removed, where)})`;
        i = end + 1;
        continue;
      }
      out += `${name}(${cleanValue(args, removed, where)})`;
      i = end + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

const DROP_PROPS = /^(behavior|-moz-binding|-ms-behavior)$/i;

/** A declaration list (style attribute / rule body without nested rules). */
function cleanDeclarations(body: string, removed: Removed, where: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < body.length) {
    const e = readUntil(body, i, ';');
    const decl = body.slice(i, e).trim();
    i = e + 1;
    if (!decl) continue;
    const colon = decl.indexOf(':');
    if (colon < 0) continue;
    const prop = decl.slice(0, colon).trim();
    if (DROP_PROPS.test(prop)) { removed.push(`${prop} in ${where}`); continue; }
    out.push(`${prop}:${cleanValue(decl.slice(colon + 1), removed, where)}`);
  }
  return out.join(';');
}

export const ROOT = '.slide.design';
const ROOT_ALIAS = /^(?:html|:root|body|\.slide|\.design|&)(?![\w-])/i;

/** Prefixes one selector with the slide root. null = dropped (would reach outside the slide). */
function scopeSelector(sel: string): string | null {
  let s = sel.trim();
  if (!s) return null;
  let root = false;
  for (;;) {
    const m = ROOT_ALIAS.exec(s);
    if (!m) break;
    root = true;
    s = s.slice(m[0].length);
    const ws = /^\s+/.exec(s);
    if (ws && ROOT_ALIAS.test(s.slice(ws[0].length))) s = s.slice(ws[0].length);
  }
  if (/^\s*[+~]/.test(s)) return null; // siblings of the slide root = the studio chrome
  return root ? `${ROOT}${s}` : `${ROOT} ${s}`;
}

/** A scoped selector whose subject is the slide root (".slide.design", ".slide.design:hover", ".slide.design.x"). */
const isRootSel = (x: string | null) => !!x && x.startsWith(ROOT) && !/^[\s>+~]/.test(x.slice(ROOT.length));

function splitTop(s: string, sep: string): string[] {
  const parts: string[] = [];
  let i = 0;
  while (i <= s.length) {
    const e = readUntil(s, i, sep);
    parts.push(s.slice(i, e));
    i = e + 1;
  }
  return parts;
}

const GROUP_AT = new Set(['media', 'supports', 'container', 'layer', 'starting-style']);
const DECL_AT = new Set(['page', 'property', 'counter-style', 'font-feature-values', 'font-palette-values', 'view-transition', 'position-try']);

type Ctx = 'top' | 'nested' | 'keyframes';

/**
 * Parses a rule list. ctx top = stylesheet (selectors scoped when `scope`), nested = inside a style rule
 * (declarations and nested rules), keyframes = keyframe blocks.
 */
function cleanRules(s: string, ctx: Ctx, scope: boolean, removed: Removed, parentIsRoot = false): string {
  let out = '';
  let i = 0;
  const decls: string[] = [];
  while (i < s.length) {
    while (i < s.length && /[\s;]/.test(s[i])) i++;
    if (i >= s.length) break;
    if (s[i] === '}') { i++; continue; } // stray close: ignore
    const e = readUntil(s, i, '{;}');
    const prelude = s.slice(i, e).trim();
    if (e >= s.length || s[e] !== '{') {
      // A statement: at-rule without block, or a declaration.
      i = s[e] === '}' ? e : e + 1;
      if (prelude.startsWith('@')) {
        const name = /^@([\w-]+)/.exec(prelude)?.[1]?.toLowerCase() ?? '';
        if (name === 'layer' && ctx === 'top') out += `${prelude};`;
        else if (name) removed.push(`@${name}`);
        continue;
      }
      if (ctx !== 'top') {
        const d = cleanDeclarations(prelude, removed, 'css');
        if (d) decls.push(d);
      }
      continue;
    }
    const close = matchClose(s, e);
    const body = s.slice(e + 1, close < 0 ? s.length : close);
    i = close < 0 ? s.length : close + 1;
    if (prelude.startsWith('@')) {
      const name = /^@([\w-]+)/.exec(prelude)?.[1]?.toLowerCase() ?? '';
      const pre = cleanValue(prelude, removed, `@${name}`);
      if (GROUP_AT.has(name)) out += `${pre}{${cleanRules(body, ctx === 'keyframes' ? 'top' : ctx, scope, removed, parentIsRoot)}}`;
      else if (/^(-webkit-)?keyframes$/.test(name) && ctx === 'top') out += `${pre}{${cleanRules(body, 'keyframes', false, removed)}}`;
      else if (DECL_AT.has(name)) out += `${pre}{${cleanDeclarations(body, removed, `@${name}`)}}`;
      else removed.push(name === 'font-face' ? '@font-face (use the brand fonts)' : `@${name}`);
      continue;
    }
    if (ctx === 'keyframes') { out += `${prelude}{${cleanDeclarations(body, removed, 'css')}}`; continue; }
    let selectors = splitTop(prelude, ',').map(x => x.trim()).filter(Boolean);
    let rootish = false;
    if (ctx === 'top') {
      const scoped = selectors.map(scopeSelector);
      if (scoped.some(x => x === null)) removed.push(`selector reaching outside the slide (${short(prelude)})`);
      selectors = scope ? scoped.filter((x): x is string => x !== null) : selectors.filter((_, k) => scoped[k] !== null);
      rootish = scoped.some(isRootSel); // the rule's subject is the slide root: nested rules must not use + or ~
    } else if (ctx === 'nested' && parentIsRoot) {
      // Nested under the slide root: "+ x", "~ x", "& + x" would reach the studio chrome.
      const kept = selectors.filter(x => !/^[+~]|&s*[+~]/.test(x));
      if (kept.length !== selectors.length) removed.push(`selector reaching outside the slide (${short(prelude)})`);
      selectors = kept;
      rootish = selectors.some(x => /^&(?![s>])/.test(x));
    }
    if (!selectors.length) continue;
    out += `${selectors.join(',')}{${cleanRules(body, 'nested', scope, removed, rootish)}}`;
  }
  return (decls.length ? decls.join(';') + (out ? ';' : '') : '') + out;
}

/** Sanitizes (and optionally scopes to the slide root) a stylesheet. */
export function sanitizeCss(css: string, opts: { scope?: boolean } = {}): { css: string; removed: Removed } {
  const removed: Removed = [];
  const out = cleanRules(normalizeCss(css), 'top', !!opts.scope, removed);
  return { css: out, removed };
}

/** Collapses duplicates: ["<script>", "<script>"] → ["<script> (x2)"]. */
export function summarize(removed: Removed): string[] {
  const counts = new Map<string, number>();
  for (const r of removed) counts.set(r, (counts.get(r) ?? 0) + 1);
  return [...counts].map(([r, n]) => (n > 1 ? `${r} (x${n})` : r));
}
