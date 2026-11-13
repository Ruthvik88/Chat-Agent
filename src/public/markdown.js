/**
 * The markdown renderer and the source list.
 *
 * Kept in its own file so it can be tested without a browser: the page imports
 * it, and `test/markdown.test.ts` imports the same functions.
 *
 * Two rules make the output safe:
 *   1. everything is escaped before it is parsed, so model output can never
 *      inject markup;
 *   2. link targets are restricted to http(s) and mailto, so a `javascript:`
 *      or `data:` URL never reaches an href.
 */

var ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return ESCAPES[c];
  });
}

/**
 * Returns a usable href, or null when the target must not be linked.
 *
 * Only absolute http(s) and mailto targets are allowed. Everything else —
 * `javascript:`, `data:`, `vbscript:`, a relative path — is refused, because
 * a search result's URL is untrusted input.
 */
export function safeUrl(raw) {
  var t = String(raw).trim();
  if (/^https?:\/\//i.test(t)) return t;
  if (/^mailto:[^\s@]+@[^\s@]+$/i.test(t)) return t;
  return null;
}

function link(href, text) {
  return '<a href="' + escapeHtml(href) + '" target="_blank" rel="noopener noreferrer">' + text + '</a>';
}

/** Inline markdown inside one already-split text run. */
function renderText(src) {
  var s = escapeHtml(src);

  // [label](target) — an unusable target degrades to plain text.
  s = s.replace(
    /\[([^\]\n]*)\]\(([^)\s]+)(?:\s+&quot;[^)]*&quot;)?\)/g,
    function (m, label, target) {
      var href = safeUrl(target);
      var text = label || target;
      return href ? link(href, text) : text;
    },
  );

  // Bare links.
  s = s.replace(
    /(^|[\s(])(https?:\/\/[^\s<>"']+)/g,
    function (m, pre, url) {
      return pre + link(url, url);
    },
  );

  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

  return s;
}

/**
 * Inline markdown for a whole line. Code spans are split out first, so their
 * contents never see the other replacements.
 */
export function renderInline(src) {
  return String(src)
    .split(/(`[^`\n]+`)/g)
    .map(function (part) {
      if (part.length > 2 && part.charAt(0) === '`' && part.charAt(part.length - 1) === '`') {
        return '<code>' + escapeHtml(part.slice(1, - 1)) + '</code>';
      }
      return renderText(part);
    })
    .join('');
}

var BLOCK_START = /^\s*(#{1,4}\s|```|>|\||[-*+]\s|\d+[.)]\s)/;

function splitRow(row) {
  return row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map(function (c) {
      return c.trim();
    });
}

function alignOf(cell) {
  var left = cell.charAt(0) === ':';
  var right = cell.charAt(cell.length - 1) === ':';
  if (left && right) return 'ta-center';
  if (right) return 'ta-right';
  if (left) return 'ta-left';
  return '';
}

function renderTable(head, align, rows) {
  var th = head
    .map(function (c, i) {
      return '<th' + (align[i] ? ' class="' + align[i] + '"' : '') + '>' + renderInline(c) + '</th>';
    })
    .join('');
  var body = rows
    .map(function (r) {
      return (
        '<tr>' +
        r
          .map(function (c, i) {
            return '<td' + (align[i] ? ' class="' + align[i] + '"' : '') + '>' + renderInline(c) + '</td>';
          })
          .join('') +
        '</tr>'
      );
    })
    .join('');
  return (
    '<div class="table-wrap"><table><thead><tr>' +
    th +
    '</tr></thead><tbody>' +
    body +
    '</tbody></table></div>'
  );
}

function renderList(items, ordered) {
  var tag = ordered ? 'ol' : 'ul';
  var html = '';
  var i = 0;
  while (i < items.length) {
    var base = items[i].indent;
    var group = [];
    while (i < items.length && items[i].indent === base) group.push(items[i++]);
    var nested = [];
    while (i < items.length && items[i].indent > base) nested.push(items[i++]);
    var nestedHtml = nested.length ? renderList(nested, false) : '';
    group.forEach(function (item, idx) {
      html +=
        '<li>' +
        renderInline(item.text) +
        (nestedHtml && idx === group.length - 1 ? nestedHtml : '') +
        '</li>';
    });
  }
  return '<' + tag + '>' + html + '</' + tag + '>';
}

export function renderMarkdown(src) {
  var lines = String(src).replace(/\r\n?/g, '\n').split('\n');
  var out = [];
  var i = 0;

  while (i < lines.length) {
    var line = lines[i];

    if (/^\s*```/.test(line)) {
      var buf = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push('<pre class="code"><code>' + escapeHtml(buf.join('\n')) + '</code></pre>');
      continue;
    }

    // A GFM table: a header row, a delimiter row, then body rows.
    if (
      /^\s*\|/.test(line) &&
      i + 1 < lines.length &&
      /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[i + 1]) &&
      lines[i + 1].indexOf('-') !== -1
    ) {
      var head = splitRow(line);
      var align = splitRow(lines[i + 1]).map(alignOf);
      i += 2;
      var rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(splitRow(lines[i++]));
      out.push(renderTable(head, align, rows));
      continue;
    }

    var heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      var level = Math.min(heading[1].length + 1, 5);
      out.push('<h' + level + '>' + renderInline(heading[2]) + '</h' + level + '>');
      i++;
      continue;
    }

    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      out.push('<hr />');
      i++;
      continue;
    }

    if (/^\s*>/.test(line)) {
      var quoted = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        quoted.push(lines[i++].replace(/^\s*>\s?/, ''));
      }
      out.push('<blockquote>' + renderMarkdown(quoted.join('\n')) + '</blockquote>');
      continue;
    }

    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      var ordered = /^\s*\d+[.)]\s+/.test(line);
      var items = [];
      while (i < lines.length) {
        var m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (!m) break;
        items.push({ indent: m[1].length, text: m[3] });
        i++;
      }
      out.push(renderList(items, ordered));
      continue;
    }

    if (!line.trim()) {
      i++;
      continue;
    }

    var para = [];
    while (i < lines.length && lines[i].trim() && !BLOCK_START.test(lines[i])) {
      para.push(lines[i++]);
    }
    if (para.length) {
      out.push('<p>' + renderInline(para.join('\n')).replace(/\n/g, '<br />') + '</p>');
    } else {
      i++;
    }
  }

  return out.join('\n');
}

/**
 * The numbered source list under an answer.
 *
 * A source's title and URL come from a web page, so both are escaped, and the
 * URL is only linked when it is an http(s) or mailto target.
 */
export function renderSourcesHtml(sources) {
  if (!sources || !sources.length) return '';
  var items = sources
    .map(function (s) {
      var title = escapeHtml(s.title || s.url || '');
      var href = safeUrl(s.url);
      var body = href ? link(href, title) : '<span>' + title + '</span>';
      if (s.publishedDate) {
        var date = escapeHtml(s.publishedDate);
        body += ' <time class="src-date" datetime="' + date + '">' + date + '</time>';
      }
      return '<li>' + body + '</li>';
    })
    .join('');
  return '<ol class="sources">' + items + '</ol>';
}
