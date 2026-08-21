# Changelog

Notable changes, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [semantic versioning](https://semver.org/).

## [1.9.0]

### Added

- **You can pick the project folder instead of typing it.** The wizard offered a list of folders
  from one directory and, past that, a text field where a typo produced a project pointing nowhere.
  There is now a "Choose…" button: it opens the real system folder dialog, and where there isn't one
  (a server with no desktop, another OS) the board falls back to its own folder browser. Either way
  the path is checked before the project is created. A browser page cannot read an absolute path by
  itself, so the board's own server does the looking.

- **The sync section explains itself now.** It used to be two empty fields and no context: what
  this does, whether it applies to one project or the whole board, and what exactly ends up on
  GitHub. It now says all of it before you type anything, including the part that matters most:
  the repository holds the issues for the whole board, you should make it private, and task titles,
  descriptions and comments are copied there in full. That is the only feature here that sends
  anything off your machine, so it says so out loud.

- **The deploy skill is picked from a list now.** The wizard asked for a "custom deploy skill" as
  free text, which assumes you already know which skills you have, and an empty field quietly turned
  into the shared `deploy` skill: nobody chose it, it was simply assigned. The list shows deploy
  skills rather than everything in your skills folder, says where to make your own, and "not set"
  stays a real answer, because a project without a deploy is a normal project.

### Fixed

- **The folder dropdown was drawn by the operating system**, which ignores everything about how the
  rest of the board looks. It now uses the same control as every other dropdown here. The field was
  also labelled "Project key", the same words as the task-key field two rows above it.

- **A failed update now ends with the command to run.** The most common way an update fails is that
  the global package directory is not writable, and there is nothing the board can do about that
  by itself — only you, in a terminal, can. It used to answer with the path to an npm debug log,
  because it picked the longest line npm marked as an error, and npm's longest lines are its own
  stack frames and file paths. It now names the cause and shows the exact command it just tried,
  with the same `--prefix`, so the one you run updates the copy that is actually running.

- **The update dialog says what happens to your work.** Two things you cannot check for yourself:
  your tasks are untouched, because they live in the data directory apart from the code, and — for
  an npm install — the Claude Code skills are a *copy*, so after updating they need
  `local-kanban skills`. Without that Claude keeps reading the instructions from the old version
  and gives no sign of it.

- **The sync section links to the README**, where the same thing is written out in more detail.

## [1.8.4]

### Changed

- **Releases publish themselves again, and carry provenance.** Publishing is now authorised by a
  trusted publisher — npm trusts this repository's release workflow directly — instead of a token
  that the account's two-factor policy would not accept anyway. Every version from here on is signed
  by the build that produced it, which anyone can check on the package page; 1.6.3 through 1.8.3 were
  published by hand and carry no such signature.

## [1.8.3]

### Added

- **A roadmap at the end of both READMEs.** More interface languages, working with Codex the way it
  works with Claude Code, plugins with declared permissions instead of blind trust, a board a team
  can share over a local network, and attaching a CLI straight to a card. Plans, not promises —
  written down so the direction is visible to anyone deciding whether to build on this.

## [1.8.2]

### Added

- **The README now opens with how you actually use the thing.** It described what the board is and
  how to install it, and left the loop itself — the part someone came for — to be inferred: write
  the task in *Backlog*, move it to *To do*, copy that column as a job for Claude, and let it work
  until it stops at *Review* for you to accept. Including the trick that makes it pay off: let
  *Review* pile up, then ask for the whole column to be checked in one pass, from a fresh chat.

### Fixed

- **The update line no longer draws over itself.** With both a status and a button on the right,
  the two together were wider than the row had left, and the status — which was not allowed to
  shrink — spilled leftwards across the label: 104 pixels of one text printed on top of another.
  The status and the button now wrap onto their own line, and the command hint next to the button
  is gone, because the button is the action and two instructions for one thing only made the row
  longer.
- **Pressing the button now visibly does something.** `npm install -g` takes tens of seconds and
  says nothing while it runs, so the board looked frozen and inviting a second click. It counts
  out loud instead — *installing… 12s*, then *restarting… 3s* — and the button reads *Updating…*
  until the page reloads itself.

## [1.8.1]

### Changed

- **The documentation caught up with the update button.** `POST /api/update` was missing from
  `docs/API.md` altogether, and both READMEs still sent you to a terminal for something the board
  now does itself. The API reference explains what the endpoint answers and — the part that is easy
  to get wrong — that `update_available: null` means the check could not be made, not that you are
  up to date. `ARCHITECTURE.md` states the rule behind it: the board never promises a restart it
  cannot perform.

## [1.8.0]

### Added

- **The board updates itself from a button.** Until now the update line told you a command to type
  in a terminal; now there is a button next to it, and it appears only when an update is actually
  waiting. It installs the update the way the board was installed — `git pull` for a clone,
  `npm install -g` for a package — and installs it into the copy that is running, not into whatever
  prefix the machine happens to prefer. Under pm2 the board then restarts itself and the tab
  reloads on its own; started by hand, it says plainly that the update is in place and the board
  has to be started again, because promising a restart nobody can perform would leave you looking
  at a dead tab.

## [1.7.1]

### Fixed

- **The update check asked the registry in a format it answers with an error.** The request carried
  npm's abbreviated media type, which is meant for a package document and not for the `/latest`
  address: the registry replies 406 with an empty body, so an npm install was told "cannot check"
  again. A cached response let it through often enough to look like a flaky network — it was not.
  Caught on a clean install of 1.7.0 minutes after it was published.

## [1.7.0]

### Added

- **An npm install can finally see that a new version is out.** The update check asked git for the
  current commit, and a package installed from npm has no git repository — so it answered "cannot
  check" every single time, and the About section showed the date of a frontend file instead of a
  version number. The board now reports its own version and compares it against the registry:
  *update available 1.6.3 → 1.7.0*, next to the command that installs it. A clone keeps the git
  check, which says more: the commit, the tag, and how many commits are waiting for a release.

### Fixed

- **A failed update check no longer sticks around for an hour.** The answer was cached for an hour
  whether it worked or not, so a single lost request kept the board saying "cannot check" long after
  the network came back. A failure is now remembered for a minute; a real answer still for an hour.

## [1.6.3]

### Changed

- **A commercial invoice is asked for by email now, not through a public issue.** Wanting to pay
  for something you use at work is not a thing anyone should have to announce in public, and the
  first line of an invoice request is the company name. `docs/COMMERCIAL.md` names an address
  instead, and asks for the two things an invoice needs: the country and how many people use the
  board.

### Fixed

- **The install section described a question the wizard never asks.** It said the wizard asks
  *where* to put the Claude Code skills. There is no choice of place — the path is
  `~/.claude/skills` — and the question is whether to install them at all; it installs two, the
  board's own skill and the deploy one. Both READMEs now describe what the program actually does.

## [1.6.2]

### Added

- **A quiet ask for companies that use the board at work.** It stays MIT-licensed and free for
  everyone — nothing is switched off, nothing to activate, and it still never contacts a server —
  but if the board earns you money, $12 a year per person keeps it maintained. The ask is one line
  in the README and one row in Settings → About, both pointing at `docs/COMMERCIAL.md`, which spells
  out what this is and, just as plainly, what it is not: not a licence purchase, not a support
  contract, and not a subscription that switches anything off when it lapses.

### Fixed

- **The bulk-registration script sent you to a file that does not exist.** `contrib/bootstrap.js`
  loads a registry of projects from `contrib/seed-projects.json`, and when that file was missing it
  told you to run `contrib/seed-from-panel.js` first — a script that is git-ignored and has never
  been in the repository, as `contrib/README.md` says a few lines below. The directory is not part
  of the published package, but it is part of the repository, so the first thing a reader of a fresh
  clone was told to do could not be done at all. The message now names
  `contrib/seed-projects.example.json`, which sits right next to the script: copy it, edit it, run
  the script. Only `slug` and `name` are required, and a test keeps the example in step with the
  fields the script actually reads — an example promising fields that are silently ignored is the
  same broken promise, only quieter.

## [1.6.1]

### Fixed

- **The buttons in the skills section could act on the previous skill instead of the one on
  screen.** Creating a skill left two requests in flight — the section re-renders and opens its
  first row, then the code opens the new skill — and whichever answered last owned the panel's
  state. In that gap the page showed the new skill while "load the shared version" fetched the text
  of another one and "delete" would have removed it: with the guard deliberately switched off, 19
  frames out of 30 showed one skill's row above another skill's path. An answer that is no longer
  the current one is now discarded, the section opens exactly one skill instead of two, and the
  buttons stay disabled until its text has arrived.

## [1.6.0]

### Changed

- **The skills section lists only what the board is about.** A skills directory holds every skill
  its owner uses in Claude Code — most of it has nothing to do with the board — and burying the rest
  behind a "show the others" line was not enough: the section is about deploy instructions. It now
  shows the board's own skill and deploy skills: the shared one, the ones registered projects use,
  and the ones created here. The full list is still where it is needed — in the deploy-skill picker
  on the project page.
- **A skill created from the board no longer disappears from the list.** Nothing on disk tells a
  skill created here apart from the rest of the library, so the board now remembers its own.
  Entering the name of a skill that already exists adopts it into the list instead of failing —
  without that, a skill outside those groups could be neither opened nor deleted.

### Added

- **A skill can be deleted from the settings**, with the resolved path in the confirmation and a
  snapshot of the file kept beforehand. **A skill that is a symlink loses only the link** — the file
  it points to usually lives in another repository and is left alone; the dialog says so before you
  press the button, not after.

### Fixed

- **"Load the shared version" no longer answers with a raw error on your own skill.** The board has
  no shared version of a skill it does not ship, so the button is simply disabled there and says why.

## [1.5.0]

### Added

- **The deploy skill of a project is picked from a list instead of typed in.** The field took a
  free-form name, so a typo left the project without a deploy and said nothing; now it offers the
  skills the board actually found, plus "not set", plus a line explaining what the field is for. A
  name that is stored but not installed stays in the list, marked as such, rather than quietly
  disappearing on the next save.
- **A skill can be created from the settings.** "New skill" asks for a name and writes the file; if
  this package ships a skill under that name, the file starts as that shared version — so taking the
  ready-made one and starting your own are the same action with a different name. The new skill
  shows up in the project's deploy-skill list immediately.
- **The project's own notes and its skill are editable where they are shown.** The viewer opened
  from project settings was deliberately read-only, which was the wrong call: a rule is worked out
  while doing a task, and writing it into `CLAUDE.md` belongs right there. Saving takes the same
  lock as a skill — it confirms the resolved path, the server checks that path itself, and the
  previous contents are snapshotted into the data directory first.

### Changed

- **The skills list is grouped.** A skills directory holds everything its owner uses in Claude Code,
  most of it unrelated to the board. The section now leads with the board's own skill and the deploy
  skills of registered projects, and keeps the rest behind a "other Claude skills" line.

## [1.4.1]

### Fixed

- **A skill used by a dozen projects broke its own row in the new "Skills" section.** The label
  listed every project by name, so it wrapped onto a second line and pushed the size and date off
  the right edge of the list. Past two projects the label now counts them ("used by 12 projects")
  and the names move into the tooltip.

## [1.4.0]

### Added

- **Project settings are a page inside the project instead of a popup at the cursor.** The popup
  was 250 pixels wide with its own scrollbar and a collapsible "paths & deploy" block, and it had
  long stopped fitting what belongs there — seven registry fields. The same places open it (the
  `⋯` button in the topbar, a right-click on a board in the sidebar); clicking `⋯` again, or Esc,
  goes back to the board.
- **The page shows what Claude reads before it starts working:** the project's own `CLAUDE.md`
  (plus `README.md` and the like when they exist) and the deploy skill it uses — the shared one or
  its own — with absolute paths, a copy button and a read-only viewer. A missing `CLAUDE.md` is
  listed too: that absence is worth knowing, since the agent will start the task without those
  notes.
- **A "Skills" section in the settings.** Skills are the instructions Claude actually reads, and
  they live outside the board, in `~/.claude/skills`; until now the board only wrote them once, at
  install time, and never mentioned them again. The section lists every skill it can find, says
  which projects use which, and shows the text of the selected one.
- **Loading the shared version of a skill and writing it to disk are two separate buttons.** A
  skill directory is often a symlink to a file in another repository — a customised copy somebody
  keeps deliberately — so a single "update" button would silently overwrite it. Loading only fills
  the editor and names the source (GitHub, or the copy that shipped with the package) and the
  language; saving is a second, explicit step that asks about the resolved path it is about to
  overwrite, and keeps a snapshot of the previous contents in the data directory first.

## [1.3.2]

### Fixed

- **The GitHub sync stopped as soon as a label differed only in capitalisation.** GitHub treats
  label names as case-insensitive; the board compared them exactly. A board whose repository
  already had, say, `NoClaude` while the palette asks for `noclaude` did not recognise it, tried to
  create it, and GitHub answered "a label with that name already exists" — which brought down the
  whole issue creation, so every task after that reported "the issue does not exist yet" and the
  error log filled up. Dropping `--force` in 1.3.0 is what exposed it: `--force` never complained
  about a label that was already there. A label that already exists is no longer treated as a
  failure at all, and a repository whose labels could not be listed is retried on the next
  operation instead of being written off until a restart.

## [1.3.1]

Three fixes found by testing the previous release rather than by using it — each one a place where
the 1.3.0 change was right in intent and incomplete in reach.

### Fixed

- **A board with its own data directory could not create a project folder.** Keeping an isolated
  instance out of the owner's live `~/claude-projects` (1.3.0) moved project folders next to the
  data directory — but nothing ever created that directory, so the first "create a folder" answered
  with an error and the feature simply did not work for anyone who chose a custom data directory
  during setup. The failure was also invisible: it never reached the error log.
- **The dashboard funnel still counted archived boards.** Archiving was made to remove a board from
  every card and every total, and it does — except for the bar chart of how many tasks sit at each
  stage, which was left counting the archived board's tasks. On one screen that put a set of
  consistent numbers next to one inconsistent one.
- **A deleted issue was retried instead of failing.** The list of GitHub answers that mean "this
  will never succeed" spelled the article one way, and GitHub writes it the other way for half the
  entries — so an issue that no longer exists was treated as a passing network problem and retried
  fifteen times before giving up.

## [1.3.0]

A full audit of the board — stability, performance and error handling — went through every part of
it, and this release is the answer to it. The headline is the tab you leave open all day: it used
to go quiet without ever saying so.

### Added

- **The board tells you when a change did not save.** With the server down, the board used to stay
  silent: a dragged card slid into its new column and drifted back on its own two seconds later, a
  description you typed went nowhere, and the title of a new task vanished without a trace — the
  only record was a failed request in the console, because the error report itself goes to the
  server that is down. A change that cannot reach the server now rolls back, lights up a "not
  saved" badge in the header, and is sent again as soon as the connection returns.
- **Archived boards can be brought back.** Archiving hid a board from the sidebar and there was no
  way back short of a raw HTTP request. Settings now has an Archive section listing what was
  archived, with a button to restore it.
- **`local-kanban skills` refreshes the Claude Code skills.** Installed from npm they were copied
  once and then never updated by anything, so the board moved forward while the instructions the
  agent reads stayed on an older version.
- **Search covers the whole description.** It only ever looked at the first 180 characters, so a
  word further in was simply not found — no result, no error, no hint that the search was partial.

### Fixed

- **A tab that lost its event stream never noticed.** The check for a dead stream ran only when the
  window was hidden or refocused — and the board is normally visible and focused all day, so
  neither ever happened. After a laptop sleep or a network timeout the board froze: finished tasks
  did not appear, and anything done from the frozen board overwrote what had happened meanwhile.
  Liveness is now checked on a timer, and a stream that recovers on its own catches up on what it
  missed.
- **A burst of events left only the last one.** Five tasks created in a row showed up as one; five
  tasks moved in a row left four cards sitting in their old column — which is worse, because a
  missing card is visible and a card in the wrong column is not. Every event in a burst is now
  applied.
- **The task panel overwrote changes made elsewhere.** It sent every field it held on any edit,
  while only refreshing the status, so setting a priority or a label from the CLI or another tab
  was rolled back within half a second. It now sends only what actually changed, shows what came
  from elsewhere, and closes itself if the task was deleted.
- **Every board render held on to the previous one.** Memory grew with each redraw for as long as
  the tab stayed on one board — tens of megabytes over a day of activity.
- **A task forgotten in a working column counted the whole time as work.** One task left in
  "doing" over a weekend turned the week's work time into fiction. A single stretch is now capped,
  and a capped number is marked as approximate instead of pretending to be exact.
- **Two snapshots taken in the same second destroyed each other,** leaving a zero-byte file under
  the final name that was listed, downloadable and counted as a backup.
- **A failing daily backup said nothing.** With the snapshot directory unwritable the board started
  normally, took no snapshots, logged nothing, and tried again six hours later. The Backups section
  now shows the last success and the last failure, and a failure is retried in minutes.
- **Attachments were in no backup at all.** Images are now mirrored alongside the snapshots and
  restored into the preview board.
- **A board opened from a backup could outlive the one that started it,** holding a port and
  serving a full copy of every task with nothing left to stop it.
- **Uploading a backup buffered the whole file in memory** and lifted the size limit from every
  other route as a side effect. The body is now streamed to disk and the limit is scoped.
- **The error log washed itself out.** A few hundred identical broken requests erased the whole
  ring, real failures included; repeats are now collapsed with a counter. A genuine server failure
  also reaches the process log — previously its only copy was the table, and if that table was the
  problem, the board pointed at a section that answered with the same failure.
- **Malformed input answered 500 instead of 400** on ten routes, and in one of them a request could
  come back 200 while writing the wrong value into a project field.
- **`kb` could not tell a refusal from a failure.** A board erroring on a request exited with the
  same code as a lawful refusal, and a reply that was not JSON — what you get when the address
  points at something else — exited zero and reported a move that never happened.
- **GitHub sync could create a second issue for one task** if the process restarted at the wrong
  moment, and an unparsed answer from `gh` started stamping out new ones. An ordinary network
  failure was also filed as permanent and never retried, and labels recoloured by hand were reset
  on every restart.
- **Archiving a project hid it from the sidebar only.** Its cards stayed on the combined board, its
  tasks stayed in "waiting for you", and it was still named in the top projects.
- **Dashboard windows were cut in UTC but drawn in local days,** so the edge of the week fell in
  the middle of a day that the calendar showed in full. The header and the dashboard also counted
  the same week by different rules.
- **A board with its own data directory still used the live project folder of the account,** listed
  it and created folders in it.
- **A relative or `~`-prefixed data directory** created a real directory named `~` and then died on
  a raw stack trace.
- **The install check in CI passed on a package that installs but does not open,** and it was not
  called on the publishing path at all.
- **A broken database died on a raw driver stack** instead of pointing at the snapshots next to it.
- **A group drag that was refused explained nothing** — the reason was computed, translated and
  thrown away.
- **Deleting the demo project left its attachments on disk,** still served over a direct link.

### Performance

Groundwork for larger boards; on a board of a couple of thousand tasks the difference today is a
few milliseconds. The task list no longer reads full descriptions off disk to return a 180-character
preview, the link map is built only for the tasks being shown, the dashboard stops scanning the whole
event log for one minimum, project counters got a covering index, and an edit that changes neither
the column nor the order redraws one card instead of the whole board. Search input is debounced.

## [1.2.1]

### Fixed

- **Creating a task threw an error every single time.** The board splits its frontend into ES
  modules, and two of them wrote to a variable owned by another module. An import is a read-only
  binding, so the assignment threw a `TypeError` and took the rest of the function with it. Three
  things were broken by it at once: a freshly created card was never scrolled into view, the board
  refresh that follows creation never ran, and the sync badge stopped updating — which also meant
  a board with no GitHub sync configured still promised "creating issue…" on every new task. Each
  creation also left an entry in the error log; on a board in daily use they were 82 of the last
  100 records.
- **A task deleted in another tab filled the error log.** The panel re-reads the task it shows on
  every board refresh, so a task deleted elsewhere logged the same "task not found" line again and
  again. Opening one now says so plainly, closes the panel and refreshes the board, and the
  periodic re-read no longer treats an expected miss as a failure.

## [1.2.0]

### Added

- **A long status history no longer buries the rest of the task.** A task that has been moved
  around for weeks collects a couple of dozen timeline rows, and they pushed everything else in
  the panel out of view. Anything longer than six entries now shows the three most recent ones
  with an arrow to expand the rest — and to fold them back.

### Fixed

- **`kb info` crashed on a project whose pm2 services were stored as a plain string.** The field
  is documented as "a comma-separated string or JSON" and both forms exist in real databases, but
  every reader parsed it as JSON only: the command exited with an error instead of printing the
  project, `GET /api/projects/:slug/status` answered 500, and the project settings showed an empty
  pm2 field that the next save would have wiped. Both forms are now read, and new values are
  stored in one canonical shape.

### Changed

- `package.json` no longer declares a `test` script. The tests are not part of the published
  package, so inside an installed one the command exited successfully having run nothing at all —
  a green check for a check that never happened. Tests are run from a clone with `node --test`.

## [1.1.0]

### Changed

- **Node 22 is now the minimum, and installing on a current Node no longer builds from source.**
  The database driver is a native module that ships prebuilt binaries per Node version. The
  pinned version had them for Node 18 through 23 only, so anyone installing on Node 24 LTS or 26
  — which is what you get if you install Node today — silently fell through to compiling the
  driver locally: minutes of waiting, a C++ toolchain required, and an outright failure on a
  machine that has none. The driver is updated to a release with binaries for Node 22, 24, 25 and
  26, `engines` states that range, and CI now tests both ends of it plus a real install on the
  current LTS. Node 20 drops out of the range: the new driver has no binaries for it and Node 20
  itself stopped receiving releases in March 2026.

## [1.0.2]

### Fixed

- **The bundled Raycast command did not work.** `scripts/raycast/open-kanban.sh` ships in the
  package, and the export step removed its `@raycast.title` and `@raycast.description` lines as
  if they were prose. They are not — Raycast parses them, and without a title it never registers
  the command. The script is now written in English and the export refuses to drop a directive.

### Changed

- `package.json` no longer advertises `bootstrap` and `seed:panel`. Neither could run from an
  installed package: one points into a directory that is not shipped, the other at a file that
  was never in the repository. The `contrib/` helpers are run directly from a clone.

## [1.0.1]

### Fixed

- **The board could not be stopped.** Neither `Ctrl+C` nor `SIGTERM` had any effect — only
  `SIGKILL` did. A module-level signal listener was registered on import and did nothing, which
  is enough to cancel Node's default terminate-on-signal. Handlers now live only for as long as
  the thing they clean up, and they exit explicitly.
- **"Stop" on a restored backup lied.** The second board opened from an uploaded backup ignored
  the stop button, the thirty-minute expiry and the next upload — same root cause — so preview
  boards piled up, each still serving a copy of the data on an open port.
- **The wizard's manual instructions assumed a git clone.** Anyone who installed from npm was
  told to run `npm link` and to symlink `skills/` from a directory they do not have; `kb` ships
  with the package and the wizard already copies the skills. The final step now branches on how
  the board was installed.
- Missing Russian translation for the dashboard "Streak" card, which never went through the
  translation layer at all.
- `npm run update` printed git's raw `fatal: not a git repository` before its own explanation of
  how to update an npm install.
- The release preflight reported "something was committed straight to main" when the real problem
  was that no local `main` branch existed.

### Changed

- The README no longer claims parts of the settings are Russian-first — English is the source
  language of the interface and a string with no translation stays English.

## [1.0.0]

First public release. A local kanban board built to work in tandem with Claude Code: the human
plans and accepts, Claude takes tasks from the queue through the `kb` CLI and stops at review.

- Board, dashboard, chaos capture, horizon and calendar views; drag and drop, task links,
  checklists, attachments, comments with images.
- `kb` — a token-efficient CLI for the whole task loop (`take`, `show`, `mv`, `review`, `done`).
- Optional one-way GitHub mirror: every task becomes an issue, every project a Projects v2 board.
- SQLite with versioned migrations, a pre-migration snapshot and rotating backups.
- Local-first by design: binds to loopback, checks request origin, ships no external resources.
- English and Russian interface, installed and set up by `npx local-kanban`.
