// The project's mark, in one place. Three rounded bars on a blue tile: the
// accounts the proxy pools, each at its own level of quota. It lives here as
// an SVG string rather than a file because the dashboard is one inline HTML
// page with no asset routes and no build step, and `src/` is what ships.
// Stroke and fill are fixed colours, not theme variables, so the same mark
// works as a browser-tab icon, where no page CSS applies.

/** The mark as a standalone SVG document, 64×64. */
export const LOGO_SVG = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">',
  '<defs><linearGradient id="tr-logo-g" x1="0" y1="0" x2="1" y2="1">',
  '<stop offset="0" stop-color="#5fbaff"/><stop offset="1" stop-color="#2b7fe6"/>',
  '</linearGradient></defs>',
  '<rect x="2" y="2" width="60" height="60" rx="15" fill="url(#tr-logo-g)"/>',
  '<rect x="15" y="30" width="9" height="20" rx="4.5" fill="#fff" opacity=".55"/>',
  '<rect x="27.5" y="16" width="9" height="34" rx="4.5" fill="#fff"/>',
  '<rect x="40" y="24" width="9" height="26" rx="4.5" fill="#fff" opacity=".8"/>',
  '</svg>',
].join('');

/**
 * The mark as a `data:` URL, for a `<link rel="icon">`. Base64 rather than
 * percent-encoding so the `#` in the colours and the gradient reference
 * cannot be read as a URL fragment by any consumer.
 *
 * @returns {string}
 */
export function logoDataUrl() {
  return `data:image/svg+xml;base64,${Buffer.from(LOGO_SVG, 'utf8').toString('base64')}`;
}

/**
 * The mark for inlining next to the product name, where the name is the
 * accessible text and the picture is decoration. Sized by the page's CSS,
 * so the fixed 64px dimensions are dropped.
 *
 * @returns {string}
 */
export function logoMarkup() {
  return LOGO_SVG.replace(' width="64" height="64">', ' aria-hidden="true" focusable="false">');
}
