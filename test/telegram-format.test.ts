/**
 * Telegram <-> Matrix formatting conversion unit tests.
 *
 *   telegramEntitiesToFormattedBody: Telegram entity ranges (UTF-16 code
 *   units — same as JS string indexing, emoji included) -> escaped Matrix
 *   formatted_body HTML.
 *
 *   matrixHtmlToTelegramHtml: untrusted Matrix formatted_body -> the strict
 *   Telegram parse_mode=HTML subset, with tag/scheme whitelisting,
 *   re-escaping, and auto-closing of unbalanced tags.
 */
import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  matrixHtmlToTelegramHtml,
  telegramEntitiesToFormattedBody,
  type TgMessageEntity,
} from '../src/services/telegram-format';

describe('telegramEntitiesToFormattedBody', () => {
  it('converts bold wrapping a text_link (the bold+link case)', () => {
    const html = telegramEntitiesToFormattedBody('Bold link ok', [
      { offset: 0, length: 9, type: 'bold' },
      { offset: 5, length: 4, type: 'text_link', url: 'https://google.com' },
    ]);
    expect(html).toBe('<b>Bold <a href="https://google.com">link</a></b> ok');
  });

  it('measures offsets in UTF-16 code units (emoji before the entity)', () => {
    // 🚀 is 2 UTF-16 units: 'go' starts at offset 3.
    const html = telegramEntitiesToFormattedBody('🚀 go', [{ offset: 3, length: 2, type: 'bold' }]);
    expect(html).toBe('🚀 <b>go</b>');
  });

  it('maps every inline entity kind to its Matrix HTML', () => {
    const html = telegramEntitiesToFormattedBody('biusxc', [
      { offset: 0, length: 1, type: 'bold' },
      { offset: 1, length: 1, type: 'italic' },
      { offset: 2, length: 1, type: 'underline' },
      { offset: 3, length: 1, type: 'strikethrough' },
      { offset: 4, length: 1, type: 'spoiler' },
      { offset: 5, length: 1, type: 'code' },
    ]);
    expect(html).toBe(
      '<b>b</b><i>i</i><u>u</u><s>s</s><span data-mx-spoiler>x</span><code>c</code>'
    );
  });

  it('pre with language becomes a Matrix code block', () => {
    const html = telegramEntitiesToFormattedBody('x = 1', [
      { offset: 0, length: 5, type: 'pre', language: 'python' },
    ]);
    expect(html).toBe('<pre><code class="language-python">x = 1</code></pre>');
  });

  it('mentions become t.me links; bare https urls become anchors', () => {
    const html = telegramEntitiesToFormattedBody('ping @ivan https://x.dev/a', [
      { offset: 5, length: 5, type: 'mention' },
      { offset: 11, length: 15, type: 'url' },
    ]);
    expect(html).toBe(
      'ping <a href="https://t.me/ivan">@ivan</a> <a href="https://x.dev/a">https://x.dev/a</a>'
    );
  });

  it('text_mention links the username when present', () => {
    const html = telegramEntitiesToFormattedBody('hey', [
      { offset: 0, length: 3, type: 'text_mention', user: { id: 1, username: 'ivan' } },
    ]);
    expect(html).toBe('<a href="https://t.me/ivan">hey</a>');
  });

  it('drops unsafe text_link schemes to plain text', () => {
    const html = telegramEntitiesToFormattedBody('link', [
      { offset: 0, length: 4, type: 'text_link', url: 'javascript:alert(1)' },
    ]);
    expect(html).toBe('link');
  });

  it('escapes text so nothing from Telegram passes through raw', () => {
    const html = telegramEntitiesToFormattedBody('<b>&amp; "q"', [
      { offset: 0, length: 12, type: 'bold' },
    ]);
    expect(html).toBe('<b>&lt;b&gt;&amp;amp; &quot;q&quot;</b>');
  });

  it('returns null for empty/missing/malformed entity lists', () => {
    expect(telegramEntitiesToFormattedBody('hi', null)).toBeNull();
    expect(telegramEntitiesToFormattedBody('hi', [])).toBeNull();
    expect(telegramEntitiesToFormattedBody('hi', [{ offset: 99, length: 5, type: 'bold' }])).toBeNull();
    expect(telegramEntitiesToFormattedBody('hi', [{ offset: 0, length: 0, type: 'bold' }])).toBeNull();
  });

  it('skips partially overlapping entities instead of corrupting output', () => {
    const html = telegramEntitiesToFormattedBody('abcdef', [
      { offset: 0, length: 5, type: 'bold' },
      { offset: 3, length: 5, type: 'italic' }, // overlaps the bold's tail
    ]);
    expect(html).toBe('<b>abcde</b>f');
  });

  it('supports deep nesting (link inside italic inside bold)', () => {
    const html = telegramEntitiesToFormattedBody('0123456789', [
      { offset: 0, length: 10, type: 'bold' },
      { offset: 2, length: 6, type: 'italic' },
      { offset: 4, length: 2, type: 'text_link', url: 'https://e.com' },
    ]);
    expect(html).toBe('<b>01<i>23<a href="https://e.com">45</a>67</i>89</b>');
  });
});

describe('matrixHtmlToTelegramHtml', () => {
  it('converts the bold+link case to Telegram HTML', () => {
    const out = matrixHtmlToTelegramHtml('<strong>Bold <a href="https://google.com">link</a></strong>');
    expect(out).toBe('<b>Bold <a href="https://google.com">link</a></b>');
  });

  it('maps strong/em/del and keeps b/i/u/s/code/pre', () => {
    const out = matrixHtmlToTelegramHtml(
      '<em>i</em><del>s</del><u>u</u><code>c</code><pre>p</pre><b>b</b><i>i</i><strike>k</strike>'
    );
    expect(out).toBe('<i>i</i><s>s</s><u>u</u><code>c</code><pre>p</pre><b>b</b><i>i</i><s>k</s>');
  });

  it('unescapes entities on the way in and re-escapes text for Telegram', () => {
    const out = matrixHtmlToTelegramHtml('a &amp; b < c > d &lt;tag&gt;');
    expect(out).toBe('a &amp; b &lt; c &gt; d &lt;tag&gt;');
  });

  it('drops javascript: anchors but keeps their text', () => {
    const out = matrixHtmlToTelegramHtml('x<a href="javascript:alert(1)">evil</a>y');
    expect(out).toBe('xevily');
  });

  it('keeps https anchors including matrix.to permalinks', () => {
    const out = matrixHtmlToTelegramHtml('<a href="https://matrix.to/#/@u:s.org">u</a>');
    expect(out).toBe('<a href="https://matrix.to/#/@u:s.org">u</a>');
  });

  it('keeps tg:// anchors', () => {
    const out = matrixHtmlToTelegramHtml('<a href="tg://user?id=5">u</a>');
    expect(out).toBe('<a href="tg://user?id=5">u</a>');
  });

  it('escapes quotes inside href values', () => {
    // HTML attributes carry quotes as &quot;; they must survive the
    // unescape -> re-escape round trip.
    const out = matrixHtmlToTelegramHtml('<a href="https://x.com/&quot;q&quot;">z</a>');
    expect(out).toBe('<a href="https://x.com/&quot;q&quot;">z</a>');
  });

  it('flattens Matrix code blocks: pre keeps the content, inner code goes away', () => {
    const out = matrixHtmlToTelegramHtml('<pre><code class="language-python">print(1 &lt; 2)</code></pre>');
    expect(out).toBe('<pre>print(1 &lt; 2)</pre>');
  });

  it('strips unknown tags but keeps their text', () => {
    const out = matrixHtmlToTelegramHtml('<div>hi<span style="x">there</span></div>');
    expect(out).toBe('hithere');
  });

  it('turns br and paragraphs into newlines', () => {
    const out = matrixHtmlToTelegramHtml('one<br>two<p>three</p>');
    expect(out).toBe('one\ntwo\nthree');
  });

  it('auto-closes unbalanced tags so Telegram never sees invalid markup', () => {
    expect(matrixHtmlToTelegramHtml('<b>bold')).toBe('<b>bold</b>');
    expect(matrixHtmlToTelegramHtml('<b><i>x</b></i>')).toBe('<b><i>x</i></b>');
  });

  it('drops stray closing tags', () => {
    expect(matrixHtmlToTelegramHtml('y</b>')).toBe('y');
  });

  it('closes inner tags when an outer tag closes early', () => {
    const out = matrixHtmlToTelegramHtml('<b>a<i>b</b>c');
    expect(out).toBe('<b>a<i>b</i></b>c');
  });

  it('escapes stray < that does not open a tag', () => {
    expect(matrixHtmlToTelegramHtml('a < b')).toBe('a &lt; b');
  });

  it('decodes numeric entities before re-escaping', () => {
    expect(matrixHtmlToTelegramHtml('&#60;&#62;')).toBe('&lt;&gt;');
    expect(matrixHtmlToTelegramHtml('&#x3c;')).toBe('&lt;');
  });

  it('returns null for empty or tag-only input', () => {
    expect(matrixHtmlToTelegramHtml('')).toBeNull();
    expect(matrixHtmlToTelegramHtml('   ')).toBeNull();
    expect(matrixHtmlToTelegramHtml('<img src="x">')).toBeNull();
  });
});

describe('escapeHtml', () => {
  it('escapes the four dangerous characters', () => {
    expect(escapeHtml(`&<>"`)).toBe('&amp;&lt;&gt;&quot;');
  });
});
