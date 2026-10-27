// Applies the saved theme before first paint to avoid a light flash in dark mode.
// A separate file (not inline) so the Content-Security-Policy can stay script-src 'self'.
try {
  var saved = (JSON.parse(localStorage.getItem('stillnote-ui') || '{}').state || {}).theme || 'system';
  var dark = saved === 'dark' || (saved === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
  document.querySelector('meta[name="theme-color"]').setAttribute('content', dark ? '#09090b' : '#fafafa');
} catch (e) {
  // Theme falls back to the stylesheet default.
}
