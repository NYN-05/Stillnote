const sanitizeHtml = require('sanitize-html');
const MarkdownIt = require('markdown-it');
const { convert } = require('html-to-text');
const policy = require('../../shared/rich-text-policy.json');
const { StoreError } = require('./storeError');

const markdown = new MarkdownIt({
  html: false, // Legacy notes never rendered raw HTML; keep that guarantee.
  breaks: true, // Preserve the line breaks people typed in the old editor.
  linkify: false,
  typographer: false,
});
// The old editor advertised GitHub-flavoured Markdown. Those constructs must
// survive the conversion, not be flattened into plain paragraphs.
markdown.enable(['table', 'strikethrough']);

const TEXT_ALIGN = /^(left|center|right|justify)$/;
const CSS_LENGTH = /^\d+(?:\.\d+)?px$/;

function styleMatchers(styles) {
  const matchers = {};
  for (const [property, values] of Object.entries(styles)) {
    // sanitize-html expects an array of regular expressions per property.
    if (property === 'text-align') matchers[property] = [TEXT_ALIGN];
    else if (values.includes('px')) matchers[property] = [CSS_LENGTH];
  }
  return matchers;
}

// The shared policy is static, so the sanitizer configuration is built once.
const ALLOWED_ATTRIBUTES = Object.fromEntries(Object.entries(policy.allowedAttributes).map(([tag, names]) => [tag, [...names]]));
const ALLOWED_STYLES = Object.fromEntries(Object.entries(policy.allowedStyles).map(([tag, styles]) => [tag, styleMatchers(styles)]));
// The style attribute is only retained on tags whose properties we explicitly match.
for (const tag of Object.keys(policy.allowedStyles)) {
  ALLOWED_ATTRIBUTES[tag] = [...new Set([...(ALLOWED_ATTRIBUTES[tag] ?? []), 'style'])];
}

const SANITIZE_OPTIONS = {
  allowedTags: policy.allowedTags,
  allowedAttributes: ALLOWED_ATTRIBUTES,
  allowedStyles: ALLOWED_STYLES,
  allowedSchemes: policy.linkSchemes,
  allowedSchemesByTag: { img: policy.imageSchemes },
  allowProtocolRelative: false,
  disallowedTagsMode: 'discard',
  transformTags: {
    a: (tagName, attribs) => ({
      tagName,
      attribs: {
        ...attribs,
        target: policy.linkTarget,
        rel: policy.linkRel,
      },
    }),
  },
};

const PLAIN_TEXT_OPTIONS = {
  wordwrap: false,
  selectors: [
    { selector: 'a', options: { ignoreHref: true } },
    { selector: 'img', format: 'skip' },
    { selector: 'table', options: { uppercaseHeaderCells: false } },
    ...['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map((selector) => ({ selector, options: { uppercase: false } })),
  ],
};

function sanitizeRichHtml(html) {
  return sanitizeHtml(html, SANITIZE_OPTIONS);
}

function htmlToPlainText(html) {
  return (
    convert(html, PLAIN_TEXT_OPTIONS)
      // eslint-disable-next-line no-control-regex -- NUL bytes are not allowed in Postgres text.
      .replace(/\u0000/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

function markdownToHtml(source) {
  return sanitizeRichHtml(markdown.render(source));
}

function validateFormat(value) {
  if (value === undefined || value === null) return 'markdown';
  if (value !== 'markdown' && value !== 'html') {
    throw new StoreError('Content format must be "markdown" or "html".', 400, 'INVALID_CONTENT_FORMAT');
  }
  return value;
}

function validateSchemaVersion(value) {
  if (value === undefined || value === null) return policy.schemaVersion;
  if (!Number.isInteger(value) || value !== policy.schemaVersion) {
    throw new StoreError(
      `Unsupported content schema version. This server supports ${policy.schemaVersion}.`,
      400,
      'UNSUPPORTED_CONTENT_SCHEMA',
    );
  }
  return value;
}

/**
 * Normalizes any accepted write into the canonical stored form: sanitized HTML
 * tagged with the current content schema. Legacy Markdown is converted, never
 * stored alongside HTML under an ambiguous tag.
 */
function normalizeContent(input) {
  if (typeof input.content !== 'string') {
    throw new StoreError('Content must be a string.', 400, 'INVALID_CONTENT');
  }
  // Postgres text cannot hold NUL bytes; strip them before measuring.
  // eslint-disable-next-line no-control-regex
  const source = input.content.replace(/\u0000/g, '');
  if (source.length > policy.maxContentLength) {
    throw new StoreError(`Content must be ${policy.maxContentLength} characters or fewer.`, 413, 'CONTENT_TOO_LARGE');
  }

  const sourceFormat = validateFormat(input.contentFormat);
  validateSchemaVersion(input.contentSchemaVersion);

  const html = sourceFormat === 'markdown' ? markdownToHtml(source) : sanitizeRichHtml(source);
  if (html.length > policy.maxContentLength) {
    throw new StoreError(`Content must be ${policy.maxContentLength} characters or fewer.`, 413, 'CONTENT_TOO_LARGE');
  }

  return {
    content: html,
    contentFormat: 'html',
    contentSchemaVersion: policy.schemaVersion,
    plainText: htmlToPlainText(html),
  };
}

module.exports = { policy, sanitizeRichHtml, htmlToPlainText, markdownToHtml, normalizeContent };
