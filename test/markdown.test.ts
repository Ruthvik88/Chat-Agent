import './setup';
import assert from 'node:assert/strict';

import { escapeHtml, renderMarkdown, renderSourcesHtml, safeUrl } from '../src/public/markdown.js';

/**
 * The renderer turns model output into HTML, and model output can carry
 * anything a web page put there. These tests hold the two rules that make it
 * safe: everything is escaped before it is parsed, and a link target is only
 * used when it is an http(s) or mailto URL.
 */

/**
 * The tags the renderer is allowed to emit. Everything else must come out
 * escaped, so no angle bracket may survive once these are taken out.
 */
const ALLOWED_TAGS =
  /<\/?(?:p|a|strong|em|del|code|pre|h[2-5]|ul|ol|li|table|thead|tbody|tr|th|td|div|blockquote|hr|br|span|time)\b[^>]*>/g;

/**
 * Asserts that the output carries no executable markup: only the tags the
 * renderer emits, and only http(s) or mailto link targets.
 */
function assertInert(html: string, label: string) {
  const rest = html.replace(ALLOWED_TAGS, '');
  assert.doesNotMatch(rest, /[<>]/, `${label}: an unescaped angle bracket survived -> ${rest}`);
  assert.doesNotMatch(html, /<script|<img|<iframe|<object|<embed/i, `${label}: a raw tag survived`);

  for (const [, href] of html.matchAll(/href="([^"]*)"/g)) {
    assert.doesNotMatch(
      href.toLowerCase(),
      /^\s*(javascript|data|vbscript|file):/,
      `${label}: an unsafe href survived -> ${href}`,
    );
  }
}

async function main() {
  // --- 1. An image tag with an event handler ---
  {
    const html = renderMarkdown('<img src=x onerror="alert(1)">');
    assertInert(html, 'img onerror');
    assert.match(html, /&lt;img/, 'the tag must be shown as text, not parsed');
  }

  // --- 2. A javascript: link ---
  {
    const html = renderMarkdown('[click me](javascript:alert(1))');
    assertInert(html, 'javascript link');
    assert.doesNotMatch(html, /<a /, 'an unusable target must not become a link');
    assert.match(html, /click me/, 'the label must still be shown');
  }

  // --- 3. A data: link ---
  {
    const html = renderMarkdown('[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)');
    assertInert(html, 'data link');
    assert.doesNotMatch(html, /<a /, 'an unusable target must not become a link');
  }

  // --- 4. Uppercase and whitespace variants of the same tricks ---
  {
    for (const target of [
      'JaVaScRiPt:alert(1)',
      '  javascript:alert(1)  ',
      'java\tscript:alert(1)',
      'vbscript:msgbox(1)',
      '//evil.example',
      '/relative/path',
      'file:///etc/passwd',
    ]) {
      assert.equal(safeUrl(target), null, `must refuse: ${target}`);
    }
    for (const target of [
      'https://example.com/a?b=1&c=2',
      'http://example.com',
      'mailto:someone@example.com',
    ]) {
      assert.ok(safeUrl(target), `must allow: ${target}`);
    }
  }

  // --- 5. Unclosed and mismatched tags ---
  {
    const html = renderMarkdown('<b>bold <i>italic</b> still</i>');
    assertInert(html, 'unclosed tags');
    assert.match(html, /&lt;b&gt;/, 'the tags must be shown as text');
  }

  // --- 6. A malformed table ---
  {
    for (const broken of [
      '| a | b |\n| --- |\n| 1 | 2 | 3 |',
      '| only | header |\n| --- |',
      '|||\n|-|-|',
      '| a |\n| - |\n| <script>alert(1)</script> |',
    ]) {
      const html = renderMarkdown(broken);
      assertInert(html, `malformed table: ${JSON.stringify(broken)}`);
    }
  }

  // --- 7. Deeply nested lists ---
  {
    const deep = Array.from({ length: 60 }, (_, i) => ' '.repeat(i * 2) + '- item ' + i).join('\n');
    const html = renderMarkdown(deep);
    assertInert(html, 'deeply nested lists');
    assert.ok(html.length < 100_000, 'the output must stay a sane size');
  }

  // --- 8. A code span keeps its contents inert ---
  {
    const html = renderMarkdown('`<img src=x onerror=alert(1)>`');
    assertInert(html, 'code span');
    assert.match(html, /<code>/, 'the code span must be a code span');
  }

  // --- 9. Raw HTML in a paragraph ---
  {
    const html = renderMarkdown('hello <script>alert(1)</script> world');
    assertInert(html, 'raw html');
  }

  // --- 10. The sources list ---
  {
    const html = renderSourcesHtml([
      { title: '<img src=x onerror=alert(1)>', url: 'https://ok.example.com' },
      { title: 'bad', url: 'javascript:alert(1)' },
      { title: 'data', url: 'data:text/html,<script>alert(1)</script>' },
      { title: 'ok', url: 'https://ok.example.com/b', publishedDate: '2026-11-04' },
    ]);
    assertInert(html, 'sources list');
    assert.match(html, /&lt;img/, 'a source title must be escaped');
    assert.equal((html.match(/<a /g) ?? []).length, 2, 'only the http(s) sources may be linked');
    assert.match(html, /2026-11-04/, 'the raw date remains in datetime');
    assert.match(html, />4 Nov 2026<|>04 Nov 2026</, 'the visible date is formatted');
    assert.match(html, /undated/, 'missing dates are labelled');
    assert.match(html, /<time class="src-date"/, 'the date must be a time element');
  }

  // --- 11. A source whose title carries quotes ---
  {
    const html = renderSourcesHtml([
      { title: '" onmouseover="alert(1)', url: 'https://ok.example.com/?a="b' },
    ]);
    assertInert(html, 'quotes in a source');
    assert.match(html, /&quot;/, 'quotes must be escaped');
  }

  // --- 12. escapeHtml itself ---
  {
    assert.equal(escapeHtml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  }

  console.log('markdown xss: all assertions passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
