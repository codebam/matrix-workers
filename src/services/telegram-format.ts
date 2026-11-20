// Formatting conversion between Matrix and Telegram messages.
//
// Matrix carries rich text as (client-trusted) HTML in content.formatted_body
// with m.format = 'org.matrix.custom.html'. Telegram carries it as message
// entities: offset/length ranges over the plain text, measured in UTF-16 code
// units — exactly how JavaScript indexes strings, so .slice() on the raw text
// is correct even across emoji.
//
//   Matrix -> Telegram: matrixHtmlToTelegramHtml() re-tokenizes the HTML and
//   keeps only the tag subset Telegram's parse_mode=HTML accepts, escaping
//   every text node and attribute (input HTML is untrusted — it comes from
//   users). The caller retries once as plain text if Telegram still rejects.
//
//   Telegram -> Matrix: telegramEntitiesToFormattedBody() builds a fresh,
//   fully escaped formatted_body from the entity list. Nothing from the
//   Telegram side passes through unescaped, so the result is inject-safe
//   even though Matrix clients render it as HTML.

/** Telegram message entity (Bot API MessageEntity). */
export interface TgMessageEntity {
  offset: number;
  length: number;
  type: string;
  /** text_link / text_mention */
  url?: string;
  language?: string;
  user?: { id: number; first_name?: string; username?: string };
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// --- Telegram entities -> Matrix formatted_body ---

/** Schemes Matrix clients will happily make clickable (and nothing else). */
const MATRIX_SAFE_URL = /^(https?:\/\/|mailto:)/i;

function entityHref(url: string): string | null {
  if (typeof url !== 'string' || !MATRIX_SAFE_URL.test(url)) return null;
  return `"${escapeHtml(url)}"`;
}

/** Wrap an already-converted (escaped) fragment in the Matrix HTML for one
 *  Telegram entity. Unknown entity types pass through as plain text. */
function wrapEntity(inner: string, e: TgMessageEntity): string {
  switch (e.type) {
    case 'bold':
      return `<b>${inner}</b>`;
    case 'italic':
      return `<i>${inner}</i>`;
    case 'underline':
      return `<u>${inner}</u>`;
    case 'strikethrough':
      return `<s>${inner}</s>`;
    case 'spoiler':
      return `<span data-mx-spoiler>${inner}</span>`;
    case 'code':
      return `<code>${inner}</code>`;
    case 'pre':
      return e.language
        ? `<pre><code class="language-${escapeHtml(e.language)}">${inner}</code></pre>`
        : `<pre>${inner}</pre>`;
    case 'text_link': {
      const href = entityHref(e.url ?? '');
      return href ? `<a href=${href}>${inner}</a>` : inner;
    }
    case 'text_mention':
      return e.user?.username
        ? `<a href="https://t.me/${encodeURIComponent(e.user.username)}">${inner}</a>`
        : inner;
    case 'mention':
      return `<a href="https://t.me/${encodeURIComponent(inner.replace(/^@/, ''))}">${inner}</a>`;
    case 'url':
      // The entity text itself is the URL; Telegram may omit the scheme for
      // www.* links, which Matrix would not render as a link.
      return /^(https?:\/\/)/i.test(inner) ? `<a href=${entityHref(inner)!}>${inner}</a>` : inner;
    default:
      // hashtag, cashtag, email, phone_number, bot_command, custom_emoji…
      return inner;
  }
}

function convertEntities(text: string, entities: TgMessageEntity[]): string {
  // Open earliest first, longest first: parents before their nested children.
  const ents = [...entities].sort((a, b) => a.offset - b.offset || b.length - a.length);
  let out = '';
  let pos = 0;
  for (let i = 0; i < ents.length; i++) {
    const e = ents[i];
    // Telegram never sends partially-overlapping entities; skip if one
    // somehow arrives (defensive — never corrupt the output).
    if (e.offset < pos) continue;
    // Everything starting inside this range is nested; rebase and recurse.
    const inner: TgMessageEntity[] = [];
    let j = i + 1;
    while (j < ents.length && ents[j].offset < e.offset + e.length) {
      inner.push({ ...ents[j], offset: ents[j].offset - e.offset });
      j++;
    }
    i = j - 1;
    out += escapeHtml(text.slice(pos, e.offset));
    out += wrapEntity(convertEntities(text.slice(e.offset, e.offset + e.length), inner), e);
    pos = e.offset + e.length;
  }
  return out + escapeHtml(text.slice(pos));
}

/**
 * Build the Matrix formatted_body fragment (attribution prefix is added by
 * the caller) for a Telegram text with entities. Returns null when there is
 * nothing to format — the caller then sends plain text only.
 */
export function telegramEntitiesToFormattedBody(
  text: string,
  entities?: TgMessageEntity[] | null
): string | null {
  if (typeof text !== 'string' || !Array.isArray(entities) || entities.length === 0) return null;
  const valid = entities.filter(
    (e) =>
      typeof e?.offset === 'number' &&
      typeof e?.length === 'number' &&
      e.length > 0 &&
      e.offset >= 0 &&
      e.offset + e.length <= text.length
  );
  if (valid.length === 0) return null;
  return convertEntities(text, valid);
}

// --- Matrix formatted_body -> Telegram HTML ---

const TG_TAG_MAP: Record<string, string> = {
  b: 'b',
  strong: 'b',
  i: 'i',
  em: 'i',
  u: 'u',
  s: 's',
  del: 's',
  strike: 's',
  code: 'code',
  pre: 'pre',
  a: 'a',
};

/** Schemes Telegram's HTML parser accepts in <a href>. */
const TG_SAFE_URL = /^(https?:\/\/|tg:\/\/)/i;

const TAG_RE =
  /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[a-zA-Z:]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>/;

function unescapeHtml(s: string): string {
  return s.replace(/&(#x?[0-9A-Fa-f]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, ent: string) => {
    if (ent[0] === '#') {
      const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    switch (ent) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      case 'nbsp': return '\u00a0';
      default: return whole;
    }
  });
}

function parseHref(attrs: string): string | null {
  const m = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(attrs);
  const raw = m?.[1] ?? m?.[2] ?? m?.[3];
  return raw ? unescapeHtml(raw) : null;
}

/**
 * Convert a Matrix formatted_body to the Telegram HTML subset
 * (parse_mode: 'HTML'). Only whitelisted tags survive; every text node and
 * attribute value is re-escaped; unsupported tags and href schemes are
 * dropped while keeping their text; unbalanced tags are auto-closed so the
 * strict Telegram parser never sees invalid markup from us. Returns null
 * when nothing usable remains — the caller should send plain text.
 */
export function matrixHtmlToTelegramHtml(html: string): string | null {
  if (typeof html !== 'string' || html.trim() === '') return null;

  // Each stack entry remembers whether its open tag was emitted, so a
  // dropped <a href="javascript:…"> still consumes its matching </a>.
  const stack: Array<{ name: string; emitted: boolean }> = [];
  let out = '';
  let i = 0;

  const emitCloseDownTo = (idx: number) => {
    while (stack.length > idx) {
      const t = stack.pop()!;
      if (t.emitted) out += `</${t.name}>`;
    }
  };

  while (i < html.length) {
    if (html[i] !== '<') {
      const next = html.indexOf('<', i + 1);
      const end = next === -1 ? html.length : next;
      out += escapeHtml(unescapeHtml(html.slice(i, end)));
      i = end;
      continue;
    }
    const m = TAG_RE.exec(html.slice(i));
    if (!m) {
      // A stray '<' that does not open a tag is text.
      out += '&lt;';
      i += 1;
      continue;
    }
    i += m[0].length;
    const closing = m[1] === '/';
    const name = m[2].toLowerCase();
    const selfClose = m[4] === '/';
    const attrs = m[3] ?? '';

    if (name === 'br') {
      out += '\n';
      continue;
    }
    // Block tags Telegram has no equivalent for become line breaks.
    if (name === 'p' || name === 'blockquote') {
      if (out && !out.endsWith('\n')) out += '\n';
      continue;
    }
    const tgName = TG_TAG_MAP[name];
    if (!tgName) continue; // unsupported tag: drop the tag, keep content

    if (closing) {
      const idx = stack.map((t) => t.name).lastIndexOf(tgName);
      if (idx !== -1) emitCloseDownTo(idx);
      continue;
    }

    if (tgName === 'a') {
      const href = parseHref(attrs);
      const safe = href !== null && TG_SAFE_URL.test(href);
      stack.push({ name: 'a', emitted: safe });
      if (safe) out += `<a href="${escapeHtml(href!)}">`;
      continue;
    }
    // Matrix wraps code blocks as <pre><code class="language-x">…</code></pre>;
    // Telegram's <pre> carries the whole block — swallow the inner <code>.
    const inPre = stack.some((t) => t.name === 'pre');
    if (tgName === 'code' && inPre) {
      stack.push({ name: 'code', emitted: false });
      continue;
    }
    if (selfClose) {
      // No content follows a self-closed tag: emit it alone.
      out += `<${tgName}/>`;
      continue;
    }
    stack.push({ name: tgName, emitted: true });
    out += `<${tgName}>`;
  }

  // Close anything left open (Telegram requires balanced tags).
  emitCloseDownTo(0);

  // Drop leading/trailing whitespace the tag flattening introduced.
  const trimmed = out.trim();
  return trimmed ? out.trim() : null;
}
