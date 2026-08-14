# Changelog

Notable changes, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [semantic versioning](https://semver.org/).

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
