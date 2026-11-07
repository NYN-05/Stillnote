const test = require('node:test');
const assert = require('node:assert/strict');
const { policy, sanitizeRichHtml, htmlToPlainText, markdownToHtml, normalizeContent } = require('../src/content');

test('Markdown conversion preserves headings, GFM tables, strikethrough and images', () => {
  const html = markdownToHtml(
    ['# Heading', '', '| a | b |', '|---|---|', '| 1 | 2 |', '', '~~gone~~', '', '![alt](https://example.com/a.png)'].join('\n'),
  );
  assert.match(html, /<h1>Heading<\/h1>/);
  assert.match(html, /<table>/);
  assert.match(html, /<thead>/);
  assert.match(html, /<th>a<\/th>/);
  assert.match(html, /<s>gone<\/s>/);
  assert.match(html, /<img src="https:\/\/example.com\/a.png" alt="alt" \/>/);
});

test('sanitizer strips scripts, event handlers, frames, SVG and unsafe URL schemes', () => {
  const dirty = [
    '<script>alert(1)</script>',
    '<img src="x" onerror="alert(1)">',
    '<svg onload="alert(1)"><circle /></svg>',
    '<iframe src="https://evil.example"></iframe>',
    '<a href="javascript:alert(1)" onclick="alert(1)">js</a>',
    '<a href="data:text/html,<script>alert(1)</script>">data</a>',
    '<a href="//evil.example">protocol relative</a>',
    '<a href="ftp://example.com/file">ftp</a>',
    '<form action="/steal"><input name="password"></form>',
    '<style>body{display:none}</style>',
  ].join('');
  const clean = sanitizeRichHtml(dirty);
  assert.equal(clean.includes('<script'), false);
  assert.equal(clean.includes('onerror'), false);
  assert.equal(clean.includes('onload'), false);
  assert.equal(clean.includes('<svg'), false);
  assert.equal(clean.includes('<iframe'), false);
  assert.equal(clean.includes('javascript:'), false);
  assert.equal(clean.includes('data:text/html'), false);
  assert.equal(clean.includes('ftp://'), false);
  assert.equal(clean.includes('<form'), false);
  assert.equal(clean.includes('<style'), false);
});

test('sanitizer keeps only explicitly allowed CSS properties and values', () => {
  const html = sanitizeRichHtml(
    '<p style="text-align: center; color: red; position: fixed">centered</p><h2 style="text-align:right">title</h2>',
  );
  assert.equal(html, '<p style="text-align:center">centered</p><h2 style="text-align:right">title</h2>');

  const table = sanitizeRichHtml(
    '<table style="width: 300px; background: red"><colgroup><col style="width: 100px; color: blue"></colgroup><tbody><tr><td>x</td></tr></tbody></table>',
  );
  assert.match(table, /<table style="width:300px">/);
  assert.match(table, /<col style="width:100px" \/>/);
  assert.equal(table.includes('background'), false);
  assert.equal(table.includes('color'), false);
});

test('links are forced to a safe target and relationship, valid schemes are kept', () => {
  const html = sanitizeRichHtml(
    '<a href="https://example.com" title="Example">web</a><a href="mailto:a@example.com">mail</a><a href="/relative">rel</a>',
  );
  assert.equal((html.match(/target="_blank"/g) || []).length, 3);
  assert.equal((html.match(/rel="noopener noreferrer nofollow"/g) || []).length, 3);
  assert.match(html, /href="https:\/\/example.com"/);
  assert.match(html, /href="mailto:a@example.com"/);
  assert.match(html, /href="\/relative"/);
});

test('images allow http(s) and relative sources but reject data: URLs', () => {
  const html = sanitizeRichHtml(
    '<img src="https://example.com/a.png" alt="a"><img src="/local.png" alt="b"><img src="data:image/png;base64,AAAA" alt="c">',
  );
  assert.match(html, /src="https:\/\/example.com\/a.png"/);
  assert.match(html, /src="\/local.png"/);
  assert.equal(html.includes('data:image'), false);
});

test('plain text is derived from sanitized HTML and preserves heading case', () => {
  const plain = htmlToPlainText(
    '<h1>My Title</h1><p>Hello <strong>world</strong> &amp; <a href="https://example.com">friends</a></p><script>bad()</script>',
  );
  assert.equal(plain, 'My Title Hello world & friends');
});

test('normalizeContent treats missing format as legacy Markdown and stores HTML', () => {
  const normalized = normalizeContent({ content: '# Title\n\nBody' });
  assert.equal(normalized.contentFormat, 'html');
  assert.equal(normalized.contentSchemaVersion, policy.schemaVersion);
  assert.match(normalized.content, /<h1>Title<\/h1>/);
  assert.match(normalized.content, /<p>Body<\/p>/);
  assert.equal(normalized.plainText, 'Title Body');
});

test('normalizeContent sanitizes HTML and rejects unknown formats or schema versions', () => {
  const normalized = normalizeContent({
    content: '<p onclick="x">ok</p><script>bad()</script>',
    contentFormat: 'html',
    contentSchemaVersion: policy.schemaVersion,
  });
  assert.equal(normalized.content, '<p>ok</p>');

  assert.throws(() => normalizeContent({ content: 'x', contentFormat: 'text' }), {
    statusCode: 400,
    code: 'INVALID_CONTENT_FORMAT',
  });
  assert.throws(() => normalizeContent({ content: 'x', contentFormat: 'html', contentSchemaVersion: 999 }), {
    statusCode: 400,
    code: 'UNSUPPORTED_CONTENT_SCHEMA',
  });
  assert.throws(() => normalizeContent({ content: 'x'.repeat(policy.maxContentLength + 1) }), {
    statusCode: 413,
    code: 'CONTENT_TOO_LARGE',
  });
});

test('shared policy exposes one schema version for server and client', () => {
  assert.equal(policy.schemaVersion, 1);
  assert.ok(policy.allowedTags.includes('table'));
  assert.ok(policy.allowedTags.includes('thead'));
  assert.deepEqual(policy.linkSchemes.sort(), ['http', 'https', 'mailto']);
});
