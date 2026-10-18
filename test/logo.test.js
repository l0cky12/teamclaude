// The logo module: one SVG, served three ways (standalone, tab icon, inline
// mark). These pin the shapes the dashboard and its policy depend on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LOGO_SVG, logoDataUrl, logoMarkup } from '../src/logo.js';

test('LOGO_SVG is a single self-contained SVG document', () => {
  assert.match(LOGO_SVG, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 64 64" width="64" height="64">/);
  assert.ok(LOGO_SVG.endsWith('</svg>'));
  assert.equal((LOGO_SVG.match(/<svg\b/g) || []).length, 1);
  // Only fixed colours: no CSS variable can resolve inside a tab icon.
  assert.doesNotMatch(LOGO_SVG, /var\(/);
  // No script, no external reference: the mark must stay inert under the
  // dashboard's policy and anywhere else it is pasted.
  assert.doesNotMatch(LOGO_SVG, /<script|href=|xlink:|url\((?!#)/);
});

test('logoDataUrl() is the SVG, base64-encoded, with the SVG media type', () => {
  const url = logoDataUrl();
  const [head, body] = url.split(',');
  assert.equal(head, 'data:image/svg+xml;base64');
  assert.equal(Buffer.from(body, 'base64').toString('utf8'), LOGO_SVG);
  // Nothing in a base64 payload needs escaping inside an HTML attribute.
  assert.doesNotMatch(body, /["'<>&#%]/);
});

test('logoMarkup() drops the fixed size and marks the picture decorative', () => {
  const markup = logoMarkup();
  assert.doesNotMatch(markup, /width="64"|height="64"/);
  assert.match(markup, /^<svg [^>]*aria-hidden="true"[^>]*>/);
  assert.match(markup, /viewBox="0 0 64 64"/);
  // Same drawing as the standalone document, only the root tag differs.
  assert.equal(markup.slice(markup.indexOf('>') + 1), LOGO_SVG.slice(LOGO_SVG.indexOf('>') + 1));
});
