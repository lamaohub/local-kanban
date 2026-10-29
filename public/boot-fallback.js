setTimeout(function () {
  document.documentElement.classList.remove('booting');
}, 8000);

// A smooth reload (smoothReload in js/core.js, a change of language) left the colour of the page that faded out: the
// same cover goes over this page before anything is drawn, and liftCurtain fades it once the page is ready. The timer
// takes it off if the code never does.
(function () {
  var CURTAIN = 'kb.session.curtain';
  try {
    var colour = sessionStorage.getItem(CURTAIN);
    if (!colour) return;
    sessionStorage.removeItem(CURTAIN);
    var html = document.documentElement;
    html.style.setProperty('--curtain', colour);
    html.classList.add('kb-curtain');
    setTimeout(function () { html.classList.remove('kb-curtain', 'kb-curtain-in', 'kb-curtain-out'); }, 8000);
  } catch (_) { /* no session storage: no cover */ }
}());

// A script of the board failing before the board has loaded almost always means the page and the code
// are from different versions — a copy the browser kept from before an update. One reload takes both
// from the board. The flag allows one reload per tab until a load succeeds (bootDone in js/init.js
// clears it), so a real bug in the code does not reload the page in a loop.
// A script that could not even be fetched (a 404 of /app.js or of any module it imports) reports on
// its own <script> element, and that event does not bubble: only a listener in the capture phase hears
// it. So the listener is in the capture phase and reads the failed script's address off the element;
// other elements that fail to load (an image, a stylesheet) are not a script of the board.
(function () {
  var KEY = 'kb.session.bootReload';
  window.addEventListener('error', function (e) {
    if (!document.documentElement.classList.contains('booting')) return; // already loaded: not a version mix-up
    var el = e && e.target;
    var file = el && el.tagName === 'SCRIPT' ? String(el.src || '') : String((e && e.filename) || '');
    if (file.indexOf(location.origin + '/') !== 0) return; // not our script (an extension, an eval, an image)
    try {
      if (sessionStorage.getItem(KEY)) return; // reloaded once already: a real bug, a reload will not help
      sessionStorage.setItem(KEY, '1');
    } catch (_) {
      return; // no session storage, so nothing would stop a loop
    }
    setTimeout(function () { location.reload(); }, 300); // lets the error reach the board's error log first
  }, true);
}());

// search before the first paint. init.js sets the same class, but as a module it runs after the page was painted once,
// section is '#…'; init.js then sets the class by its own choice.
(function () {
  try {
    var q = new URLSearchParams(location.search);
    var slug = sessionStorage.getItem('kb.session.slug');
    if (!slug) {
      var start = null;
      try { start = JSON.parse(localStorage.getItem('kb.set.startScreen')); } catch (_) { /* a broken value: the default */ }
      if (start === 'chaos') slug = '#chaos';
      else if (start === 'last') slug = localStorage.getItem('kb.ui.project');
    }
    if (q.get('view') === 'dash') slug = '#dash';
    if (q.get('action') === 'new') slug = '*';
    if (!slug || slug.charAt(0) === '#') document.documentElement.classList.add('boot-view');
  } catch (_) { /* no storage: init.js decides */ }
}());

// a light flash on every open of a dark board, and on a phone, which starts dark, on every open at all. The same rule as
// getSetting and applyTheme in js/settings.js and onPhone in js/phone-rules.js; applyTheme sets it again after.
(function () {
  try {
    var t = null;
    try { t = JSON.parse(localStorage.getItem('kb.set.theme')); } catch (_) { /* a broken value: the default */ }
    if (t === 'claude') t = 'dark';
    if (t === 'coral') t = 'light';
    if (t !== 'light' && t !== 'dark' && t !== 'system') {
      var phone = matchMedia('(hover: none) and (pointer: coarse)').matches && Math.min(screen.width, screen.height) < 600;
      t = phone ? 'dark' : 'light';
    }
    if (t === 'system') t = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', t);
  } catch (_) { /* no storage or no matchMedia: applyTheme decides */ }
}());
