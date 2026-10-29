# local-kanban

[![tests](https://github.com/lamaohub/local-kanban/actions/workflows/test.yml/badge.svg)](https://github.com/lamaohub/local-kanban/actions/workflows/test.yml)

A local kanban board built for working **in tandem with Claude Code**: the human plans and accepts tasks, Claude takes them from the queue, does the work and reports back — all through a token-efficient CLI called `kb`. Optionally mirrors everything to GitHub (issues + Projects v2).

Русская версия — [README.ru.md](README.ru.md).

![Board](docs/screenshot-board.png)

![Dashboard](docs/screenshot-dashboard.png)

## How you use it

1. **Write the task** in the project's **Backlog** — a title is enough, the description can come later.
2. **Move it to *To do*** once it is ready to be picked up. That column is the queue.
3. **Press ▶ on the *To do* column** (*"Start these tasks in Claude"*). Claude starts working at once,
   right inside the board: nothing opens, the card shows its screen on the *Terminal* tab, and you answer
   its questions there. Without `tmux` on the machine the board opens Claude in the project's folder
   instead — a new session in the Claude app, or a terminal running `claude`; **Settings → Claude Code →
   Start tasks** decides. A single card has its own ▶ in its header. The copy button next to it gives
   you the same text to paste wherever you like. The tasks you start move to *Prep* the moment
   Claude starts, so *To do* holds only what nobody has started yet. The Claude app is the exception:
   the board only puts the prompt there, you send it, and Claude moves its tasks to *Prep* itself.
4. **Claude takes it from there.** It reads the task, does the work, leaves comments as it goes,
   commits and pushes, deploys if the project has a deploy skill, ties the commit to a GitHub issue
   if sync is on — and stops at **Review**. It never marks anything done.
5. **You accept.** Look at what came out and move the card to **Done**, or send it back with a note.
   That note is the first thing Claude reads when it picks the task up again. While the Claude that the
   board started is still there and waits for you, the **>_** button next to the comment's send arrow
   hands your comment to it as well, and it carries on in the same session. Accepting or cancelling the
   task closes that Claude.

**A trick worth knowing.** Let *Review* pile up — ten, twenty, thirty cards. Then add one more task to
the board: *go through everything in Review, try to break it, move what survives to Done*. Claude will
take the whole column in one pass, and it saves a lot of clicking. Do that one **in a fresh chat**: the
session that just wrote the code is the worst judge of it, because it remembers what it meant rather
than what it actually shipped. The **Claude review** section in the sidebar does all of it with one
button per project: it lists what is in Review, makes that task with the list in it and starts a fresh
Claude on it — the report stays on the card of the check.

## Why

- **A queue for Claude, not just a board.** Statuses model the real loop: `backlog → todo → prep → doing → deploy → review → done`. Claude pulls the next task with `kb take`, works, and stops at *review* — accepting is always the human's call.
- **Local-first.** Everything lives in a single SQLite file on your machine. GitHub sync is optional and off until you configure it.
- **Honest metrics.** Work time is measured only while Claude actually works; the dashboard shows streaks, cycle time and what's waiting for you.

## Security model — read this first

The server listens on **127.0.0.1 only** and has **no authentication**. The board is strictly local: your machine is the trust boundary. **Never expose the port to the network** (no reverse proxies, no `0.0.0.0`, no port forwarding). Third-party integrations should run on the same machine and talk to `127.0.0.1` (see [docs/API.md](docs/API.md)).

The one exception is your own switch: **Settings → Wi-Fi** opens a separate door on the local network (port + 10, `KB_SHARE_PORT`) for people you show its QR code to. Only the link's secret lets anyone in, and with it a guest can do on the board everything you can — including talking to Claude on your computer. It is off by default; switching it off closes the door, a new link drops every guest.

**The board holds no credentials.** A project can name an SSH host to deploy to, but neither a key
nor a password is ever entered here: the board simply runs `ssh <host>`, and who you are, on which
port and with which key is decided by your own `~/.ssh/config` — the same file your terminal uses.
A password will not work at all, because the board connects without prompts, so key-based access is
required. The short test: if `ssh <host>` works in your terminal, it works here.

## Requirements

- **Node.js ≥ 22** (macOS or Linux) — 24 LTS or newer is what most people have
- Optional, only for GitHub sync: [`gh` CLI](https://cli.github.com/) authenticated with the `project` scope:
  `gh auth login && gh auth refresh -s project`
- Optional, for starting Claude right inside the board: Claude Code
  (`claude`) and `tmux` (`brew install tmux` on macOS)

## Install

```bash
npm install -g local-kanban
local-kanban            # setup wizard
local-kanban start      # board at http://localhost:3100
```

The wizard asks for the port, the data directory, whether you want GitHub sync, and whether to install the two Claude Code skills — the board's own and the deploy one — into `~/.claude/skills`. Every question has a default, so Enter-Enter-Enter is enough. It also writes `ecosystem.config.cjs` for autostart under [pm2](https://pm2.keymetrics.io/).

`local-kanban start` takes `--port <N>` and `--data <dir>`. Data lives in `~/.local-kanban` by default, outside the package directory, so updating the package never touches your board.

From source:

```bash
git clone <repo-url> local-kanban && cd local-kanban
npm install
npx local-kanban     # setup wizard (optional)
npm start            # board at http://localhost:3100
```

To get the `kb` command globally: `npm link` (or `npm install -g .`).

First launch shows an empty dashboard with an optional **demo project** — one click creates it, one click removes it.

### Let Claude finish the setup

The last step of the first-run wizard shows a ready-made prompt (in the board's language). Paste it
into Claude Code and it will walk you through the rest — check that `kb` works, ask whether you want
the GitHub mirror, register your first projects with their paths and deploys, and verify the result.
The same prompt lives in **Settings → About**, so you can come back to it later.

### Claude Code skills

The repo ships two skills for Claude Code in `skills/`:

- `skills/kanban` — teaches Claude the task workflow (`kb take` → work → `kb review`);
- `skills/deploy` — a generic deploy flow driven by the project registry (`kb info`).

Install by symlink or copy:

```bash
ln -s "$(pwd)/skills/kanban" ~/.claude/skills/kanban
ln -s "$(pwd)/skills/deploy" ~/.claude/skills/deploy
```

### Connect the board to Claude Code (optional)

One command sets up both things below — the rate limits in the sidebar and answering Claude from the card:

```bash
local-kanban hooks install     # from a clone: node bin/local-kanban hooks install
```

It shows what it is going to add to `settings.json` in the Claude folder and asks
first; your own hooks and status line stay, the previous file is kept in the board's backups (the command asks the
running board where they are; when the board is not running, name its data folder: `--data <dir>`), and
`local-kanban hooks uninstall` takes off exactly what it added. The setup wizard offers the same step.

The Claude folder is `~/.claude`, or `$CLAUDE_CONFIG_DIR` when Claude Code was moved there. `KB_CLAUDE_DIR` wins
over both — for the board and for `local-kanban hooks` alike: the board reads Claude's sessions, transcripts and
skills there, and the entries go into its `settings.json`. Set it when the board runs with another environment
than your terminal (under pm2, say) and Claude Code's folder is not `~/.claude` — otherwise the entries land in
a file your Claude Code never reads.

On the board, **Settings → Claude Code** does the same with a button — after showing exactly what it will write — and
shows what else the board needs of Claude Code on this computer: the `claude` program, `tmux`, the Claude app, the
board's skill, and whether the status line and the hook really work. Each missing piece says how to fix it.
The board finds `claude` on its PATH, where the installers put it, and — on a Mac — inside the Claude app, which keeps
a copy of Claude Code of its own; with none of those, the section gives the one-line install command.
With two boards on one computer, only one of them can be connected: the section names the board that holds the
connection, and **Connect** asks before it takes the connection over.
Its **Show on the board** switches hide Claude's usage (the dashboard block and the line in the ⋯ menu of a card) and the
rate-limit footer, if you would rather not see them — say, when you work in the Claude app and the footer only
ever says "no data".

What it adds, if you would rather do it by hand:

#### Rate limits in the sidebar

The sidebar footer shows how much of your Claude subscription's 5-hour and weekly limits is used. Claude Code
gives these figures only to the [status line](https://code.claude.com/docs/en/statusline) command, so
`kb statusline` takes that JSON, sends the limits to the board and passes the JSON on unchanged. Put it in
front of the status line you already have, in `~/.claude/settings.json`:

```json
"statusLine": { "type": "command", "command": "kb statusline | node ~/.claude/my-statusline.js" }
```

If your status line is more than one command (`cd … && …`, `input=$(cat); …`), let `local-kanban hooks install`
write it: it wraps your command so all of it reads the JSON, and passes the JSON on even when kb cannot start.

With no status line of your own, use `kb statusline --line` — it prints a short `5h 24% · 7d 41% · ctx 8%`.
The footer follows the session that reported last: switch to another Claude account and it shows that
account's figures.
The limits arrive for Pro and Max subscribers after Claude's first answer in a session. The Claude desktop
app has no status line, so a board that only desktop sessions talk to shows "no data".

#### Answering Claude from the card

When Claude Code is about to ask you something — a permission, a question, a plan to approve — the board can
show it in the card of the task and take your answer there. Claude keeps its own dialog meanwhile: whichever
side answers first wins. Add the PermissionRequest hook to `~/.claude/settings.json`:

```json
"hooks": { "PermissionRequest": [ { "matcher": "*", "hooks": [ { "type": "command", "command": "command -v kb >/dev/null && exec kb hook permission || true", "timeout": 1800 } ] } ] }
```

The hook steps aside at once when the board is not running or the session works on no task of the board.
The guard around `kb` keeps Claude Code quiet once the board is gone (a hook that cannot start is an error
notice on every permission request), and `exec` lets kb take the shell's place, so answering in Claude's own
window stops kb itself.
Every answer given on the board is written into the task's history; it is never mirrored to GitHub.

#### Your environment and the board's Claude

Claude started by the board gets your own settings for Claude from the environment the board was started in
(`ANTHROPIC_*`, `CLAUDE_CODE_*` — an API key, Bedrock or Vertex), as in your terminal. Two of them change how it
signs in, and **Settings → Claude Code** names both:

- `CLAUDE_CODE_SIMPLE` — Claude Code's bare mode: no sign-in to your subscription, no hooks, no skills. The board
  starts its Claude without it, inside the board and in the Terminal it opens; in `"env"` of `settings.json` it
  cannot take it off — remove it there.
- `ANTHROPIC_API_KEY` — Claude Code asks once whether to use it, and *yes* means working on that key, paid for by
  the API, instead of your subscription. To stay on the subscription, start the board from a terminal without it;
  `/status` in Claude shows which way it signed in.

The board takes answers from its own page: a web page of another site cannot send one. A program on your
computer can — anything that reaches the board's port can list the waiting requests and answer them,
Claude itself included if its permission rules let it run `curl` without asking. With the board connected,
do not allow Claude unasked network commands to the board.

## GitHub sync (optional)

Set the owner and issues repo in **Settings → Sync** on the board (or env `KB_GH_OWNER` / `KB_GH_REPO`). Without them the board runs in local-only mode: no queue, no warnings. With them, every task becomes an issue and every project gets a `kb: <slug>` GitHub Project with matching columns. Sync is one-way (board → GitHub) and runs in the background.

One repository holds the issues for the whole board, not one per project, and you create it yourself before filling the fields. **Make it private:** titles, descriptions and comments are copied there in full, and this is the only feature that sends anything off your machine. The `gh` CLI has to be signed in with the `project` scope (`gh auth login && gh auth refresh -s project`) - without that scope the issue is still created, but the card never appears on the Projects board, which is a confusing way to find out.

## Updating

From npm:

The board checks for a new version itself and offers a button in **Settings → About** — it installs
the update the way the board was installed and, under a process manager, restarts and reloads the
page on its own. Started by hand, it says the update is in place and waits for you to start it again.
The Claude Code skills the setup copied come along: a copy that matches the board's version is brought up to
date, one that already differs stays as it is, and **Settings → Claude Code** says when the board's skill is not
the board's version — **Settings → Skills** takes it in one click, keeping the old file in the backups.

By hand, from an npm install:

```bash
npm install -g local-kanban@latest
local-kanban skills          # refresh the Claude Code skills — they are a copy, not a link; a file it replaces is kept in <data>/backups/skills
pm2 restart kanban           # or stop `local-kanban start` and run it again: the running board still has the old code
```

From a clone:

```bash
npm run update   # git pull + npm install + pm2 restart (if applicable)
```

Your data is never touched by updates: `data/` is gitignored and schema migrations run automatically on start — **with a pre-migration snapshot** saved to `data/backups/pre-migrate/` before anything changes.

**Rollback:** stop the server, restore the latest file from `data/backups/` (daily) or `data/backups/pre-migrate/` over `data/kanban.db`, then `git checkout <previous tag>` and start again.

Releases live in `main` (stable, tagged); day-to-day development happens in `dev`.

## Removing the board

Take it off Claude Code first: **Settings → Claude Code → Disconnect**, or `local-kanban hooks uninstall`. With the board stopped, the command asks for its data folder, where it keeps a copy of settings.json:
`local-kanban hooks uninstall --data <data folder>`. Then
`npm uninstall -g local-kanban` (or delete the clone), and if you no longer want them, the data folder
(`~/.local-kanban` by default) and the skills in `~/.claude/skills/kanban` and `~/.claude/skills/deploy`.

Removed it without disconnecting? Claude Code keeps working and stays quiet — the hook checks that the board is
still there — but the two entries stay in `~/.claude/settings.json`, and a status line the board was printing
on its own goes blank. Take them out by hand: the `PermissionRequest` hook whose command has
`kb hook permission`, and from `statusLine` the board's part in front of your own command — the
`{ … kb statusline 2>/dev/null || cat; } | {` line and the closing `}` — or the whole `statusLine` when its
command is just `… kb statusline --line`.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3100` | HTTP port (bound to 127.0.0.1) |
| `KB_DATA_DIR` | `./data` | data directory (SQLite, attachments, backups) |
| `KB_LOCAL_ROOT` | `~/claude-projects` | root folder scanned for local projects |
| `KB_URL` | `http://127.0.0.1:3100` | board URL for the `kb` CLI |
| `KB_GH_OWNER` / `KB_GH_REPO` | — | GitHub sync target; empty = sync off (can also be set in Settings) |
| `KB_PANEL_URL` | — | custom HTTP source of service statuses; empty = local `pm2 jlist` |
| `KB_PANEL_INFO` | — | optional path to an external panel's info.json for category sync |
| `KB_SSE_MAX` | `20` | cap on concurrent SSE connections |
| `KB_SHARE_PORT` | `PORT + 10` | port of the Wi-Fi door (Settings → Wi-Fi), off until you switch it on |
| `KB_SKILLS_EXTRA` | — | extra skill root directories, `:`-separated |
| `KB_GH_BIN` | — | path to the `gh` binary when it is not in a usual place (Homebrew, `/usr/bin`, `~/.local/bin`) |
| `KB_CLAUDE_DIR` | `$CLAUDE_CONFIG_DIR`, else `~/.claude` | the Claude Code folder: the board reads sessions, transcripts and skills there, and `local-kanban hooks` and Settings → Claude Code write its `settings.json`; wins over `CLAUDE_CONFIG_DIR` |

The legacy names `PANEL_URL` and `PANEL_INFO` (without the prefix) still work as a fallback.

## Metrics and the `noclaude` label

Tasks done **by hand** (without Claude) get the `noclaude` label — they are counted separately on the dashboard and excluded from Claude's metrics (work time, cycle, completion %), which would otherwise be skewed by their zero work time. The label is optional and can be added later. Manual tasks are also allowed to jump straight to *review*/*done*. Claude never gets them: ▶ and the copy button on *To do* leave them out, the board refuses to start Claude on one, and `kb take` passes them by.

## Extending

The full HTTP API and the SSE event stream are the official extension point — build bots, stats, integrations as separate programs, no plugins inside the page. See [docs/API.md](docs/API.md).

## Development

```bash
node --test   # DB isolated via KB_DATA_DIR
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the dev setup, branch flow and the schema-migration rule. The architecture is described in [ARCHITECTURE.md](ARCHITECTURE.md), and what changed between versions in [CHANGELOG.md](CHANGELOG.md).

## UI language

English is the source language of the interface; Russian comes as a translation. The board follows your system language and can be switched in **Settings → General** — a string with no translation yet stays English rather than leaking into the wrong locale.

## Using it at work

The board is MIT-licensed and free for everyone: nothing is switched off and there is nothing to
activate. If it earns you money — inside a company, or on paid client work — $12 a year per person
keeps it maintained. A request, not a rule: [docs/COMMERCIAL.md](docs/COMMERCIAL.md).

## What's planned

Not promises — the direction the project is heading:

- **More interface languages.** English and Russian are in. The dictionary is a single file, so a
  translation is a pull request rather than a project.
- **Working with Codex** the way it works with Claude Code. The `kb` CLI and the status model are not
  Claude-specific; only the skills are.
- **Plugins, done properly** — a manifest with declared permissions and a sandboxed frame, not a
  checkbox that trusts whatever you installed. A plugin that can read your tasks and reach the
  network has to say so before it runs.
- **A board a team can share** — over one local network to start with, without turning a local-first
  tool into a service that needs accounts, a server and someone to run it.
- **Attaching a CLI straight to the board**, so an agent can be driven from the card instead of from
  a terminal window next to it.

And the long one: get the dream job at Anthropic and build this for everyone.

## License

[MIT](LICENSE).
