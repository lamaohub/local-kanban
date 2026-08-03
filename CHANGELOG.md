# Changelog

Notable changes, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [semantic versioning](https://semver.org/).

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
