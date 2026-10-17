// Light, Dark or match the device, chosen in Settings (Light by default, like the Mac app).
// Runs before the stylesheet so the first paint is already the right theme.
(function () {
  var choice = 'light';
  try { choice = localStorage.getItem('ec-theme') || 'light'; } catch (e) { /* private mode */ }
  var dark = choice === 'dark' || (choice === 'system' && window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
  document.querySelector('meta[name=theme-color]').setAttribute('content', dark ? '#1B1916' : '#F2EDE3');
})();
