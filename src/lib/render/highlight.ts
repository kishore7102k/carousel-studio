// ponytail: regex highlighter for short slide snippets (JS/TS/HTML/CSS/shell). Swap for shiki if a language looks wrong.
const KEYWORDS = new Set(['const', 'let', 'var', 'function', 'return', 'import', 'from', 'export', 'default', 'if', 'else', 'for', 'while', 'await', 'async', 'class', 'new', 'type', 'interface', 'extends', 'true', 'false', 'null', 'undefined', 'npm', 'npx', 'install', 'def', 'in', 'of', 'try', 'catch', 'throw']);
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const TOKEN = /(\/\/.*$|#.*$|<!--.*?-->|\/\*.*?\*\/)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(<\/?[A-Za-z][\w-]*|\/?>)|(\b[A-Za-z_][\w-]*(?==)|\b[A-Za-z_]\w*\b)|(\b\d+(?:\.\d+)?\b)/g;

export function highlight(line: string): string {
  let out = '', last = 0;
  for (const m of line.matchAll(TOKEN)) {
    out += esc(line.slice(last, m.index));
    const [tok, comment, str, tag, word, num] = m;
    if (comment) out += `<span class="c">${esc(tok)}</span>`;
    else if (str || num) out += `<span class="s">${esc(tok)}</span>`;
    else if (tag) out += `<span class="tg">${esc(tok)}</span>`;
    else if (word && (KEYWORDS.has(word) || line[(m.index ?? 0) + word.length] === '=')) out += `<span class="k">${esc(tok)}</span>`;
    else out += esc(tok);
    last = (m.index ?? 0) + tok.length;
  }
  return out + esc(line.slice(last));
}
