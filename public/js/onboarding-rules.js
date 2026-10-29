
/** Where to ask the author about anything; the welcome step links it. */
export const CONTACT_URL = 'https://t.me/danielmarkoff';
export const CONTACT_NAME = '@danielmarkoff';

/** The steps of the wizard. A board with projects already — someone who updated — is not offered the demo project;
    everything else is the same for everyone: how to use the board is asked again after an update. */
export function onboardingSteps(hasProjects) {
  return ['lang', 'access', 'claude', 'view', 'sync', ...(hasProjects ? [] : ['demo']), 'done'];
}

export const STEP_HEADS = {
  lang: { eyebrow: 'Welcome to local-kanban', title: 'Your tasks on a board.', title2: 'Claude does them.',
    lead: 'This is a local kanban board built to work in tandem with Claude Code. A couple of steps and you are ready.' },
  access: { eyebrow: 'Permissions', title: 'What the board asks for', title2: 'Check it right here.',
    lead: 'The board lives in your browser and on your computer: a few permissions decide whether it reaches you. Each line checks itself — allow what you need.' },
  claude: { eyebrow: 'Claude Code', title: 'How will ▶ start Claude?', title2: 'Pick the way you work.',
    lead: '▶ on To do and on a card hands the tasks to Claude Code. Choose how:' },
  view: { eyebrow: 'The board', title: 'What to show on the board', title2: 'Start lean.',
    lead: 'Switch off what you do not need — it can be switched back in Settings.' },
  sync: { eyebrow: 'Optional · GitHub', title: 'GitHub sync (optional)', title2: 'Or keep it all local.',
    lead: 'Every task can be mirrored to an issue and every project to a GitHub Project. Requires the gh CLI authenticated with the project scope (gh auth login && gh auth refresh -s project). You can also enable this later in Settings.' },
  demo: { eyebrow: 'Try it', title: 'Demo project', title2: 'Tasks in every column.',
    lead: 'Create an example project with tasks in every column? It shows links, checklists and labels, and can be deleted with one click in the project settings.' },
  done: { eyebrow: 'Get started', title: 'All set!', lead: 'All of it can be changed in Settings.' },
};

// now holds every Claude at work side by side
export const FEATURES = [
  { id: 'take', icon: 'play', title: 'Claude takes the tasks', note: '▶ hands To do to Claude Code — it moves each card as it works.' },
  { id: 'watch', icon: 'chat', title: 'Talk to it from the card', note: 'Its chat: what it says, its steps folded, its questions as a form — or its terminal, if you like.' },
  { id: 'now', icon: 'terminal', title: 'Every Claude at once', note: 'Claude now shows each Claude at work side by side; an interrupted one goes on with Continue.' },
  { id: 'accept', icon: 'check', title: 'Done is your word', note: 'Claude stops at Review: you accept the work or send it back.' },
];

/** The ways ▶ can start Claude, in the order offered (the values of the `launch` setting), and why one cannot here:
    `avail` — the answer of GET /api/launch; before it comes nothing is said to be missing. */
export function launchChoices(avail = {}) {
  const has = (k) => !(k in avail) || Boolean(avail[k]);
  return [
    { value: 'board', title: 'Inside the board', note: 'Claude starts at once inside the board — you follow it and answer it right on the card',
      off: has('board') ? '' : 'needs tmux and Claude Code — not found on this computer' },
    { value: 'terminal', title: 'In Terminal', note: 'a Terminal window opens with Claude already at work',
      off: has('terminal') && has('cli') ? '' : 'needs Claude Code in a terminal — not found on this computer' },
    { value: 'desktop', title: 'In the Claude app', note: 'the app opens with the tasks typed in — you press Enter',
      off: has('desktop') ? '' : 'the Claude app is not installed on this computer' },
    { value: 'copy', title: 'Only copy the prompt', note: '▶ copies the tasks — you paste them into any Claude yourself', off: '' },
  ];
}

/** What the board shows that one may not want — the settings the wizard asks about (their defaults are in settings.js). */
export const VIEW_CHOICES = [
  { key: 'showUsage', title: 'Claude usage', note: 'tokens and approximate money: the block on the dashboard and a line in the ⋯ menu of a card' },
  { key: 'showLimits', title: 'Claude limits', note: 'the 5-hour and weekly limits of the subscription, at the bottom of the sidebar' },
  { key: 'compactCards', title: 'Compact cards', note: 'hide the description preview — more cards fit on screen' },
];

export function accessLines({ perm = 'default', on = false, macos = null, app = null, unchecked = false } = {}) {
  const out = [];
  if (perm === 'granted') out.push({ id: 'notify', mark: on ? 'ok' : 'warn', text: on ? 'Notifications: allowed and on' : 'Notifications: allowed, but off on the board' });
  else if (perm === 'denied') out.push({ id: 'notify', mark: 'no', text: 'Notifications: blocked by the browser' });
  else if (perm === 'unsupported') out.push({ id: 'notify', mark: 'warn', text: 'Notifications: this browser cannot show them' });
  else out.push({ id: 'notify', mark: 'no', text: 'Notifications: not allowed yet' });
  if (macos && typeof macos.full_disk === 'boolean') {
    out.push({ id: 'macos', mark: macos.full_disk ? 'ok' : 'warn', text: macos.full_disk ? 'macOS: Full Disk Access is given' : 'macOS: will ask about the data of other apps' });
  } else if (unchecked) out.push({ id: 'macos', mark: 'warn', text: 'This computer: not checked — the board did not answer' });
  if (app) {
    out.push({ id: 'app', mark: app.installed ? 'ok' : 'no',
      text: app.installed ? 'App: installed' : app.insecure ? 'App: not from this address' : 'App: open in a browser tab' });
  }
  return out;
}

const SCAN_IDS = ['claude', 'tmux', 'app', 'terminal', 'folder', 'skill', 'hook'];
// rows that are there only to warn: in the check only when they do (bare mode, an API key over the subscription)
const SCAN_WARN_IDS = ['bare', 'key'];

export function scanLines(rows, tr = (s) => s) {
  const out = [];
  for (const id of [...SCAN_IDS, ...SCAN_WARN_IDS]) {
    const r = rows.find((x) => x.id === id);
    if (!r || (SCAN_WARN_IDS.includes(id) && r.state === 'ok')) continue;
    const name = tr(r.title);
    // a hook that is there but not this board's (another board, other paths) is a warning, as in Settings — not "not connected"
    if (r.state === 'warn') out.push({ id, text: `${name}: ${tr('not as the board needs it')}`, mark: 'warn' });
    // Settings is for a Claude in Terminal or the app
    else if (id === 'hook') out.push({ id, text: r.state === 'ok' ? `${tr('Connected')}: ${name}` : `${name}: ${tr('come to the board from its own Claude')}`, mark: 'ok' });
    else if (r.state === 'ok') out.push({ id, text: `${tr('Found')}: ${name}`, mark: 'ok' });
    else out.push({ id, text: `${tr('Not found')}: ${name}`, mark: 'no' });
  }
  return out;
}

export const scanReady = (lines) => lines.some((l) => (l.id === 'claude' || l.id === 'app') && l.mark === 'ok')
  && !lines.some((l) => l.id === 'bare' && l.mark === 'warn');
