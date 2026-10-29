/* How to make the board an app of its own — a window without tabs and an address bar, with an icon in the Dock, the
   taskbar or on the home screen — in the browser it is open in. The page carries a manifest, so every browser that
   makes apps of pages can make one of the board; only the path through its menus differs.
   A leaf: no imports, no DOM — the tests run it in node. The texts are English, settings.js passes them through tr(). */

export const INSTALL_BROWSERS = ['chrome', 'edge', 'safari', 'ios', 'android', 'firefox'];

/** The browser of a user agent string. `touch` is navigator.maxTouchPoints: an iPad asks for the desktop site and
    calls itself a Mac, and only the touch screen gives it away. */
export function browserOf(ua = '', touch = 0) {
  if (/iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && touch > 1)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  if (/Firefox\//.test(ua)) return 'firefox';
  if (/Edg\//.test(ua)) return 'edge';
  if (/Chrome\/|Chromium\//.test(ua)) return 'chrome';
  if (/Safari\//.test(ua)) return 'safari';
  return null;
}

export const INSTALL_STEPS = {
  chrome: {
    name: 'Chrome, Arc, Brave and other Chromium browsers',
    steps: [
      'click the install icon at the right end of the address bar (a screen with an arrow), or open the ⋮ menu → Cast, save and share → Install page as app…',
      'press Install — the board opens in its own window, and its icon lands in the Dock or the taskbar',
    ],
  },
  edge: {
    name: 'Edge',
    steps: [
      'open the … menu → Apps → Install this site as an app',
      'press Install — the board opens in its own window, and its icon lands in the taskbar or the Dock',
    ],
  },
  safari: {
    name: 'Safari on a Mac',
    steps: [
      'in the menu bar: File → Add to Dock… (macOS Sonoma and newer)',
      'press Add — the board gets its own window and an icon in the Dock',
    ],
  },
  ios: {
    name: 'iPhone and iPad',
    steps: [
      'in Safari press Share — the square with an arrow',
      'pick Add to Home Screen, then Add — the icon opens the board without the address bar',
    ],
  },
  android: {
    name: 'Android',
    steps: [
      'open the ⋮ menu of the browser → Add to Home screen (or Install app)',
      'press Install — the icon opens the board without the address bar',
    ],
  },
  firefox: {
    name: 'Firefox',
    steps: [
      'Firefox on a computer does not make apps of pages',
      'open this address in Chrome, Edge or Safari and make the app there',
    ],
  },
};

/** What the section shows.
    `installed` — the board is already open as an app (display-mode standalone, or navigator.standalone on iOS);
    `prompt` — the browser offered to install it (beforeinstallprompt), so a button does it in one click;
    `insecure` — Chromium browsers make an app only of a page at localhost or over https: a board opened at a LAN
    address over http shows the menu item greyed out, and the steps would lead nowhere. Safari does not ask. */
export function installView({ ua = '', touch = 0, standalone = false, secure = true, canPrompt = false } = {}) {
  const browser = browserOf(ua, touch);
  const chromium = browser === 'chrome' || browser === 'edge' || browser === 'android';
  return {
    browser,
    installed: !!standalone,
    prompt: !standalone && !!canPrompt,
    insecure: !standalone && !secure && chromium,
    here: browser ? INSTALL_STEPS[browser] : null,
    others: INSTALL_BROWSERS.filter((b) => b !== browser).map((b) => INSTALL_STEPS[b]),
  };
}
