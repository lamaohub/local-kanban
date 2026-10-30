# HTTP API & SSE — the official extension point

The board is a plain HTTP server on `http://127.0.0.1:3100`. Everything the UI and the `kb` CLI do goes through this API, so external tools (bots, stats, importers, notifiers) can do the same — as **separate programs running on the same machine**. There are no in-page plugins by design: an external process can't touch the board's DOM or leak its data.

## Trust model

The server binds to **127.0.0.1 only** and has **no authentication**: the local machine is trusted, the network is not. **Do not** expose the port via reverse proxies or port forwarding. Anything that can make HTTP requests on your machine has full access to the board — that is the intended model, same as any local dev tool.

The one way in from the network is the owner's own switch, **Settings → Wi-Fi**: a separate door on `0.0.0.0:<port + 10>` (`KB_SHARE_PORT`) that lets in requests from private networks only (no secret in the address; another site may only open the board as a page, its forms, fetches and frames get 403) and passes the request on to the board on loopback marked `x-kb-guest: 1`. A guest can do on the board what the owner can. Off by default; switching off closes the door and every connection.

## Conventions

- JSON in/out (`Content-Type: application/json`), except image uploads (raw `image/*` body).
- Tasks are addressed by **key** `PREFIX-N` (e.g. `DEMO-3`, case-insensitive) or numeric id.
- Projects are addressed by **slug** or prefix.
- Errors: `4xx/5xx` with `{ "error": "message" }`. A field of the wrong type (an object where a string is
  expected, a number for a slug) is a `400` that names the field — never a silent conversion.
- Task descriptions may contain raw newlines — use a tolerant JSON parser when piping through a shell.

## Stability contract

**Public (kept backward-compatible):** `/api/tasks*`, `/api/projects` (GET/POST/PATCH), `/api/events` and its event types, `/api/sync` (GET), `/api/stats`.
**Internal (may change without notice):** `/api/dashboard`, `/api/now`, `/api/done`, `/api/automations`, `/api/health`, `/api/limits`, `/api/share`, `/api/asks`, `/api/claude`, `/api/about`, `/api/update-check`, `/api/update`, `/api/whats-new`, `/api/backups`, `/api/horizons`, wizard helpers (`/api/projects/clone`, `/api/projects/server-git`, `/api/projects/demo`), `/api/sync/*` mutations.

New fields may be added to responses at any time — parse leniently.

## Tasks

| Method & path | Meaning |
|---|---|
| `GET /api/tasks?project=<slug>` | tasks of a project (add `all=1` to include backlog/done/cancelled) |
| `GET /api/tasks?q=<words>&limit=N` | search: title, the whole description, key and labels, any case; with `limit`, at most N matches (never more than 200), the open and the most recently changed first — without it, every match |
| `GET /api/tasks/:key` | full task: events timeline, `links`, `attachments`, `checklist`, `commit_url`, `sessions` |
| `POST /api/tasks` | create: `{project, title?, description?, status?, priority?, labels?}` — status only `backlog`/`todo`; `title` optional |
| `PATCH /api/tasks/:key` | update any of title/description/status/priority/labels/pinned/blocked… Transition rules are enforced (e.g. `backlog → done` is rejected; label must be from the palette). `labels` replaces the whole set; `labels_add`/`labels_remove` (arrays) change the set the board has instead, so two clients editing labels at once do not wipe each other's — send one form or the other. Moving a task that is already in `prep` into `prep` again is a second claim on it: only the Claude session holding it may (the one that moved it there, or one tied to it since — the board started it on that card, or it wrote to the task); anyone else gets 409 "already taken". A change that makes the task an open check (the `check` label put on, a report sent back to `todo`) while its project has another one goes through, and the answer carries `warning: {reason: "check-open", key, text}`. `description_base` (text, optional) — the description the edit started from: when the task's description has changed since (another client wrote it), the `description` of the request is not written, the rest of the edit is, and the answer carries `description_conflict: true` with the description that stays — ask the person which one to keep; without it the last write wins |
| `POST /api/tasks/take` | take the next task of `{project}` (slug or prefix): moves it `todo → prep` and answers `{task, blocked_n, by_hand}` — `task` is the full task, as `GET /api/tasks/:key` gives it, or `null` when there is nothing to take; `blocked_n` counts the blocked tasks left in To do; `by_hand` lists the keys of the To do tasks labelled `noclaude` (never taken), in the column's order. Picking and moving are one step, so two clients taking at once get two different tasks. A pinned task goes first, then priority and position — the order of the board's column; blocked tasks are skipped |
| `DELETE /api/tasks/:key` | delete task + attachments (closes the GitHub issue if synced) |

**Field naming.** A bare name is always a **collection**, a `_n` suffix is always a **count**.
The task *list* carries `comments_n`, `attachments_n` and `linked_ids` (ids only — enough to draw
the lines on the board); the single-task response carries `links`, `attachments` and `checklist`
as arrays of objects. Nested-route params follow one scheme: `:commentId`, `:attachmentId`,
`:itemId`, `:linkedId`.

| `POST /api/tasks/:key/duplicate` | copy title/description/priority/labels into a new `todo`/`backlog` task. A copy of a check that would be a second open one is refused: 409 `{reason: "check-open", key}` — the key of the copied check itself when it is open, of the project's open check otherwise; a copy landing in `backlog` is not open and goes through |
| `POST /api/tasks/:key/move` | move the task to another project: `{project}` (slug or prefix). It keeps its id and everything on it and takes the next number there; the old key keeps leading to it. Refused: a task in work (409 `{reason: "in-work"}`, manual tasks excepted), the same or an archived project (400), an open check into a project that has one (409 `{reason: "check-open", key}`). Answers the task with `old_key`; event `task.moved` |
| `GET/POST /api/tasks/:key/comments` | comments; POST `{body, author?}` or a raw `image/*` body (screenshot) |
| `DELETE /api/tasks/:key/comments/:commentId` | delete a comment (local only) |
| `POST /api/tasks/:key/links` | link tasks: `{key, rel: related\|child\|parent}` |
| `DELETE /api/tasks/:key/links/:linkedId` | unlink |
| `POST /api/tasks/:key/attachments` | raw `image/*` body ≤ 6 MB → stored file, returned with `url` and absolute `path` |
| `GET /api/tasks/:key/attachments` / `DELETE …/:attachmentId` | list / remove |
| `GET/POST/PATCH/DELETE /api/tasks/:key/checklist[/:itemId]` | checklist items `{text, done, position}` |
| `GET /api/tasks/:key/work` | the work feed: what Claude did on this task, from the transcripts of its sessions — see below |
| `GET /api/live` | `{tasks}` — the Claude state of every task in work that a session is tied to — see below |
| `GET /api/now` | `{runs, tasks_n}` — what Claude is working on right now, grouped by the run of Claude that holds each task — see below |
| `GET /api/done` | `{runs}` — what Claude has finished lately, the most recently finished run first — see below |
| `GET /api/automations` | `{on, rules, now}` — the automations: the switch and the rules, waiting ones first — see below |
| `PUT /api/automations/switch` | `{on}` — switch the automations on or off; the answer is the view |
| `POST /api/automations` | arm a rule: `{project, delay_min?, words, launch?}` — 409 `armed` when the project has one waiting |
| `DELETE /api/automations/:automationId` | take a waiting rule off (it goes to the history), or drop an ended one from it |
| `GET /api/health` | `{norms, everywhere, projects}` — the size of the instructions Claude Code reads in each project not archived: `norms` (`lines` 200 per CLAUDE.md, `file_chars` 40 000 per file, `total_chars` 120 000 for all together); `everywhere` — the person's own files (`files`, `chars`, `lines`); per project `main` (its own CLAUDE.md: `path`, `lines`, `chars`, or null), `files` (everything a session started in its folder reads: `kind` `main`/`parent`/`local`/`import`/`rule`/`memory`, `path`, `lines`, `chars`, `from` for an import), `chars`, `lines`, `nested` (CLAUDE.md of subfolders); `folder: null` — none set, `missing: true` — not on this computer. Names and counts only, never the text |
| `GET /api/tasks/:key/chat` | the chat of one session of the task: its turns, the words waiting for its Claude, whether it can be spoken to — see below |
| `POST /api/tasks/:key/chat` | words for the board's own Claude of the task: `{text, images?}` — typed at once if it waits at its prompt, else queued; `images` — up to 10 ids of the task's attachments, each pasted to Claude Code as a picture before the words (the words may then be empty); `now: true` — typed at once even to a Claude at work (409 `question` over an open question) |
| `POST /api/tasks/:key/chat/queue/:itemId/now` | type queued words at once, past the queue — as `now: true` |
| `POST /api/tasks/:key/chat/stop` | stop the board's own Claude of the task at its turn (Esc); 409 `not-busy` when it is not at work, `stopping` within 1.5 s of the last stop |
| `DELETE /api/tasks/:key/chat/queue/:itemId` | take queued words back before they go |
| `GET /api/tasks/:key/chat/picture/:toolId?session=` | the picture file a `Read` step of the task's session read — found by the step's id (`pic` of the step), never by a path: a picture type (png, jpg, gif, webp), a file, at most 25 MB; a step that failed has none (404) |
| `GET /api/tasks/:key/chat/image/:ref?session=` | a picture the person sent in a turn of the task's session — Claude Code keeps it in the transcript itself; `ref` is one of the turn's `shots`: a picture type its own bytes confirm, at most 25 MB; anything the chat does not offer is 404 |
| `GET /api/launch` | `{board, desktop, terminal, cli}` — which ways of starting Claude this machine has |
| `POST /api/launch` | start Claude: `{mode: board, text, project, keys?, permission?, effort?}` (inside the board) or `{mode: desktop\|terminal, text, project?}` (`effort?` for terminal), or open a session that worked on a task: `{mode: desktop, host}` / `{mode: terminal, resume, project?}` — see below |
| `GET /api/tasks/:key/terminal` | the board's own Claude on this task: `{session, dead, exit?, cols, screen, wraps, links, v}`, or `{session: null}`; `?cols=` lays its window out for a screen that wide, `?seen=<v>` answers `{same: true, v}` while nothing changed — see below |
| `POST /api/tasks/:key/terminal` | type into it: `{text?, key?}` |
| `POST /api/tasks/:key/terminal/message` | a message to that Claude: `{text}` — only while it waits at its prompt; 409 with `reason` otherwise |
| `DELETE /api/tasks/:key/terminal` | stop that Claude, or close the screen of one that has finished |
| `POST /api/projects/:slug/folder` | give a project without a folder on this computer a new, empty one in the projects root — `demo`, or `demo-2` if `demo` is taken; 409 if it has one |

Statuses: `backlog → todo → prep → doing → deploy → review → done` (+ `cancelled`). Tasks labeled `noclaude` may jump straight from `backlog`/`todo` to `review`/`done`.

**Claude Code sessions.** A request may carry `X-Claude-Session: <uuid>` — `kb` sends the
`CLAUDE_CODE_SESSION_ID` that Claude Code sets for every command it runs. A status change, a comment
or a checklist tick with that header ties the task to the session, as long as the task ends up in
`prep`, `doing`, `deploy` or `review` (grooming a backlog card is not work on it); the status change
also records the session in the task's history. Anything that is not a UUID is ignored and the
request goes through as usual. The single task then carries `sessions`, oldest first:
`{session_id, transcript, first_seen, last_seen}`, where `transcript` is the path to the session's
transcript on this machine (`<claude dir>/projects/<folder>/<id>.jsonl`, the Claude directory being
`KB_CLAUDE_DIR`, then `CLAUDE_CONFIG_DIR`, then `~/.claude`) or `null` when it is not here. None of
it is mirrored to GitHub. Inside the Claude desktop app `kb` also sends `X-Claude-Host-Session: local_…`
(`CLAUDE_CODE_HOST_SESSION_ID`, the app's own id of the session); each session then carries
`host_session`, which opens that very session in the app.

**The work feed** (`GET /api/tasks/:key/work`) answers `{items, items_n, sessions}`: the newest 400
items, oldest first, and how many there are in all. An item is `{at, kind, text, session}` with
`kind` one of `user` (what the person wrote), `text` (what Claude wrote) and `tool` (a step: `tool`
names it — `Bash`, `Read`, `Edit`, `Agent`… — and `text` is a one-line summary; `ms` and `error` come
from its result, `answer` carries the person's reply to a question, `helper: {steps, ms, live}`
describes a helper agent). A session that works through several tasks is cut by task: the feed holds
only the stretches when the session was on this one, judged by the status changes it made.
`GET /api/tasks/:key/work?count=1` answers only `{items_n}` — for a counter while the feed itself is not
shown; it reads no helpers and sends no items. Requests for the same feed that arrive while it is being
built get that one build.

**The chat** (`GET /api/tasks/:key/chat?session=&turns=&seen=`) answers `{session, sessions, turns, earlier_n,
queue, send, state, model, v}` (`model` — the model of the session's newest answer, or null): the newest `turns` (15 by default, up to 200) turns of one session of the task — the one
asked for, which must be the task's, else the newest. A turn is `{at, user, images?, shots?, items, ms, open, compact?}`: the
person's words (`images` — how many pictures came with them, `shots` — those the board can show, `[{ref, w?, h?}]` for
`…/chat/image/:ref`, with the picture's size when its head tells it), then Claude's `text` and its steps (`tool` items as in the work feed, with `ms` and `error`, and `wrote` — how long Claude took to write the step, when that is 3 s or more; a `Read` of a
picture has `pic` — the step's id for `…/chat/picture/:toolId`; an answered `AskUserQuestion` has `answers`
`[{h?, q, a}]` — header, question, answer), `ms` —
how long Claude worked on it, `open` — not over yet. What a step returned is never sent. `pace` — what Claude Code's spinner says of a Claude at work in a board terminal, `{tokens?, thinking?, compacting?}`: it is not part of `v`, and comes with a `same` answer too. `queue` — the words waiting
for that Claude, `{id, text, images_n?, at}`; `send` — whether the chat can speak to it (only the board's own Claude of the task,
in the session shown); `state` — `idle`, `busy`, `question` or `gone` while it can; with `question`, `question` carries
the last lines of its screen — the question, to be answered with the keys of `POST /api/tasks/:key/terminal`. `?seen=<v>` answers `{same: true,
v}` while nothing changed; the stream sends `session.chat` with `{session}` when the transcript grows or the queue
moves. `POST` answers `{sent: true, prep, doing}` (the task moves as words typed into its terminal move it) or
`{queued: true, id}`; queued words go once that Claude has waited at its prompt for two seconds, one at a time; 409
with `reason: gone` when no Claude of the board works on the task, `full` when twenty wait already.

**Live state** (`GET /api/live`) lists `{id, key, project, project_name, title, status, claude, since}`
for tasks in `prep`/`doing`/`deploy`. `claude` comes from Claude Code's own registry of live sessions
(`<claude dir>/sessions/*.json`) and is `busy`, `waiting` (a permission ask or a question), `idle`
(its turn ended while the task is still in work) or `gone` (the process is no longer running — or the board's own
terminal of a session it started has closed); `starting` — Claude was started by ▶ less than two minutes ago and has
not shown up yet; `unsent` — an earlier version of the board moved the task when ▶ handed the prompt to the Claude app,
and nobody has sent it there yet (after two hours such a task is `gone`; a start in the app moves no task now); `since`
is when that state began, in ms. `busy`/`waiting`/`idle` are given only for the task the session is
on right now, not for the rest of a batch it moved to prep; `gone` is given for every task in work
whose last session has ended. An `idle` task whose turn ended on a broken connection to the API (Claude Code's own
error line, kind `server_error`, is the last line of the conversation) also has `broke`: `retrying` — the board tells
its own Claude to go on by itself (at most three times in a row), `stuck` — it cannot (a Claude started outside the board,
the tries are used up, the words did not reach it), and the person is needed. The dashboard's `waiting.claude` carries
the tasks that are not `busy`, `starting`, `unsent` or `broke: retrying`, with `broke` when they have it.

**Claude now** (`GET /api/now`) groups every task in `prep`/`doing`/`deploy` by its run — the latest
session tied to it, the one its badge follows — together with the tasks that run has handed in
(`review`, `done`) or still holds in `todo`; a cancelled task leaves its run. A run is `{session, claude,
since, stale, started_at, active_at, tasks_n, submitted_n, percent, tasks}`: `claude` and `since` as in
the live state above, `percent` is the share of its tasks handed in; `board: true` when the board started
that Claude in its own terminal (its screen is `GET /api/tasks/:id/terminal` of any of its tasks). Tasks in work that no session is
tied to are grouped by project, with `session: null`. `stale: true` means nobody leads the run — its
session has ended or, without a session, nothing has moved for two hours. Live runs come first, the
newest on top, then the stale ones, the most recently left on top. A task is `{id, key, project,
project_name, title, preview, status, blocked, updated_at, checklist_n, checked_n, percent, focus,
stale_h}`, listed top to bottom: handed in, the one its session is on (`focus`), the rest by stage, then
To do. Its `percent` follows the checklist when it has one, the stage otherwise (`todo` 0, `prep` 25,
`doing` 50, `deploy` 75, `review` and `done` 100); `stale_h` is the hours without a move, past two.
`tasks_n` counts the tasks in work — the same sum as the projects' `c_prep`, `c_doing` and `c_deploy`.

**Claude done** (`GET /api/done`) is `{runs}`: what Claude has finished in the last seven days, at most 30 runs,
the most recently finished first. A run is `{session, started_at, finished_at, tasks_n, review_n, done_n, tasks}`
— a session none of whose tasks is in `prep`/`doing`/`deploy`, with its tasks in `review` and `done` in the order
it handed them in; `finished_at` is its last move into Review. Tasks no session is tied to are put together by
project, hand-ins no more than an hour apart, with `session: null` (then `started_at` is the first hand-in); tasks
labelled `noclaude` are left out. A task is `{id, key, project, project_name, title, preview, status, handed_at,
done_at}`.

**Automations** (`GET /api/automations`) is `{on, rules, now}`. A rule is `{id, project, project_name, kind, delay_s,
state, created_at, ended_at, error, check_key, check_status}`, times in milliseconds; `state` is `armed`, `fired`,
`failed`, `cancelled` or `covered` — a check was made by hand after the rule was set (the last 20 ended ones are kept). A waiting rule adds `phase` — `idle` (no work in the project
since it was set), `working`, `held` (`reason`: `question`, `ask`, `sent-back`, `limit`, `check-open`, `nothing`,
`off`) or `ready` — with the `keys` it is about, and `due_at` once its pause runs. `POST` takes `delay_min` (whole
minutes, 0–120, default 3), `words` — the check's `{title, tasks, later, done, report, run, doTask}` in the page's
language — and `launch` `{permission, effort}` for the start; 409 `no-folder` when the project has no folder here. Every change goes out as the event `automation.updated`
with the same view.

## Projects

| Method & path | Meaning |
|---|---|
| `GET /api/projects` | registry with per-status counters |
| `GET /api/projects/:slug` | one project (+ `deploy_skill_path`) |
| `POST /api/projects` | create: `{slug, name, path?, server?, server_path?, pm2_services?, domain?, deploy_skill?, category?, prefix?}`. `slug` is one path segment: latin letters, digits, `.`, `-`, `_`, not starting with `.` or `-`, up to 100 characters |
| `PATCH /api/projects/:slug` | update the same fields; `archived: 1` hides a project. `name` cannot be emptied; `prefix` is a string of 2-10 latin letters or digits |
| `GET /api/projects/:slug/status` | live service statuses (local pm2 by default, or `PANEL_URL` provider) |
| `GET /api/projects/folders` | folders on disk vs registry: `{root, unregistered, missing}` |
| `POST /api/projects/folders` | mkdir/adopt a folder under `KB_LOCAL_ROOT` as a project |
| `GET /api/projects/:slug/docs` | what Claude reads before working: `{path, path_exists, docs[], skill}` |
| `GET /api/projects/:slug/docs/:name` | the text of one of those documents (+ `real_path`) |
| `PUT /api/projects/:slug/docs/:name` | `{text, confirm_path}` → writes it back, keeping a snapshot |

`pm2_services` is stored as a JSON array serialized to a string, e.g. `"[\"my-api\"]"`. On write it
also accepts a comma-separated string (`"my-api, my-bot"`) or a real array and stores the canonical
form; on read, older rows holding a bare string are still parsed, so both forms are safe.

`GET /api/projects/:slug/docs` lists the project's own notes — `CLAUDE.md`, `CLAUDE.local.md`,
`AGENTS.md`, `README.md`, `ARCHITECTURE.md` — with absolute paths, plus the deploy skill the project
uses (`generic: true` when it is the shared `deploy` one). `CLAUDE.md` is listed even when the file
is missing: that absence is information, not an empty answer. The name in `/docs/:name` must be one
of those five — the folder comes from the registry, but a basename from the URL joined onto it would
be a way out of the folder. Writing back takes the same lock as a skill: the client echoes the
resolved path it meant to overwrite, and the previous contents are snapshotted into
`<data>/backups/docs/` first.

### Status provider contract (`PANEL_URL`)

If you point `PANEL_URL` at your own endpoint, return either a bare array or `{"pm2": [...]}` of:

```json
{ "name": "my-api", "status": "online", "uptime": 1720000000000, "restarts": 3, "memory": 52428800, "cpu": 0.4 }
```

`uptime` — ms timestamp of process start; only `name` and `status` are required.

## Skills

Skills are the instruction files Claude reads (`SKILL.md`). They live outside the board, in the
`skills` folder of the Claude directory (`KB_CLAUDE_DIR`, then `CLAUDE_CONFIG_DIR`, then `~/.claude` —
the same directory the sessions are found in) plus any root listed in `KB_SKILLS_EXTRA`.

| Method & path | Meaning |
|---|---|
| `GET /api/skills` | `{roots, folder, board_skill, generic_deploy_skill, items[], board, packaged_skills[], own_skills[]}` — every skill found, with the projects using it; `folder` (`{path, from}`) is the skills folder of the Claude folder and which variable gave it (`KB_CLAUDE_DIR`, `CLAUDE_CONFIG_DIR` or `default`); `packaged_skills` are the ones this package ships, `own_skills` the ones the board itself created or adopted. Each item and `board` carry `package_state`: the copy against the files the package ships — `same`, `differs`, `link` (a symlink, never compared), `missing`, or `null` for a skill the package does not ship |
| `GET /api/skills/:name` | `{name, path, real_path, symlink, exists, size, mtime, text}` |
| `GET /api/skills/:name/upstream?lang=` | the shared version: GitHub first, the copy shipped with the package as a fallback; the response says which (`source`, `lang`) and writes nothing |
| `PUT /api/skills/:name` | `{text, confirm_path}` → writes the file (and marks it as the board's own) |
| `POST /api/skills/:name/adopt` | marks an existing skill as the board's own; the file is not touched |
| `POST /api/skills/:name/refresh` | `{confirm_path}` → writes the files the package ships for this skill, each one that differs snapshotted first, and answers `{name, written, kept, state}`. A path through a symlink is never written (409, `reason: "link"`); a `confirm_path` that is not the file the write goes to is a 409 with `reason: "changed"`; a skill the package does not ship is a 404 |
| `DELETE /api/skills/:name` | `{confirm_path}` → removes it, keeping a snapshot |

`confirm_path` is a lock, not a formality: a skill directory is often a symlink to a file in another
repository, so the client has to echo back the **resolved** path it meant to overwrite (`real_path`).
A mismatch is a `409` naming the real path, not a silent write to the wrong file. The previous
contents are copied into `<data>/backups/skills/` before the write. A name is one path segment
(`[A-Za-z0-9_-]{1,64}`); a check board started from a backup refuses to write or delete skills at all.

Deleting takes the same confirmed path and snapshots the file first. **A skill directory that is a
symlink loses only the link** — the file it points to belongs to another tree and is never removed;
the response says so with `link_only: true`.

`own_skills` exists because a skills directory holds every skill its owner uses in Claude Code,
most of it unrelated to the board. Nothing on disk distinguishes a skill created here from the rest,
so the board remembers its own — the ones it wrote or adopted — and shows those alongside the board
skill and the deploy skills of registered projects.

## Events (SSE)

`GET /api/events` — `text/event-stream`; each message is `data: {"type": "...", "data": {...}}`.

Types: `task.created`, `task.updated` (includes `prev_status` on real transitions), `task.deleted`, `task.comment`, `task.linked`, `task.attached`, `project.updated`, `sync.status`, `ping` (heartbeat every 30 s — treat a silence longer than ~75 s as a dead connection and reconnect).

Read the stream as it comes: once more than 4 MB of it is waiting for a client, the board closes that
stream rather than keep it in memory. Reconnect and read the board again, as after any break.

Events that change one card carry what that card shows: `task.created` and `task.updated` are the task
as the list gives it (with `comments_n` and `attachments_n`); `task.comment` (`{task_id, key, project,
comment, comments_n}` — `comment` is absent when one was deleted) and `task.attached` (`{task_id, key,
attachments_n}`) carry the new count; `task.linked` (`{id, key, linked}`) carries the links of both tasks
as `{<id>: [linked ids]}`, the same as `linked_ids` in the list.

`task.work` (`{ids, keys}`) says the transcript of a session working on those tasks has grown — read
their feed again if you show it. It comes at most every second and a half per session while Claude
works, so it is not a reason to re-read the board.

`task.checklist` (`{task_id, key, project, checklist_n, checked_n}`) says a task's checklist changed: an
item was added, removed, ticked or unticked — rewording one sends nothing. The board moves the task's
percent in *Claude now* by it; the list of tasks carries no checklist, so it is not a reason to re-read
the board either.

**Starting Claude** (`POST /api/launch`). `desktop` opens the Claude app with
`claude://code/new?folder=<folder>&q=<text>` (macOS), or with `{host}` the existing session
`claude://code/continue?session=local_…`; `terminal` opens Terminal (macOS) or `x-terminal-emulator`
(Linux) running `cd <folder> && claude '<text>'`, or `claude --resume <id>` with `{resume}` — with the full path of
the program in place of `claude` when the board found it off its PATH (see `GET /api/claude`). The folder
is the registered `path` of `project` — a path in the request is not read at all. A project whose folder
is not on disk is refused with 409 and `reason: 'no-folder'`, as below (Claude would start in the home
folder otherwise); without `project` it starts with no folder. `text` is at most 14 336 characters, the
most the Claude app takes. The answer is `{ok, folder, prep}` — `prep`, the keys moved to `prep`: the Terminal moves
the tasks of `keys` still in Backlog or To do; `desktop` moves none (the link only puts the prompt in the app — the
person sends it, and Claude moves its tasks itself) — or a refusal with `error`. Set `KB_LAUNCH_DRYRUN` and the board answers with the
command it would run (`{dry: true, cmd, args}`) and opens nothing.

`board` opens nothing: it starts `claude --allowedTools <the board's kb commands> --permission-mode <permission>
--name <key> --session-id <id> '<text>'` in a background tmux session of the board (socket `local-kanban`, `KB_TMUX_SOCKET`), in the
registered folder of `project` — which is required, and so is `tmux`; without either the refusal carries
`fallback: true`, and the page tries the next way; `reason` says why — `no-project`, `no-folder` (with
`project`, `name`, `missing` — the registered path that is not on disk — and `suggest`, the folder
`POST /api/projects/:slug/folder` would create), `no-tmux`, `no-claude`, and with 400 `too-long`: the
prompt goes to tmux as an argument, and tmux takes 16 364 bytes for the whole start — a Cyrillic letter is
two. `permission` is `auto` (the default), `acceptEdits`,
`manual` or `plan`. `effort` — `low`, `medium`, `high`, `xhigh` or `max` — goes as `CLAUDE_CODE_EFFORT_LEVEL`, inside the
board and in the Terminal, and stands above any level of the person's own for that session; without it Claude Code
decides by its own settings. The Claude app takes no level from its link: a desktop start with `effort` is refused. In any of them the board's own working commands (`kb take`, `info`, `note`, `review`…)
go without asking — `kb done`, `cancel` and `rm` do not. The board picks the session id and ties it to every task in `keys` at once, so
`GET /api/tasks/:key` has `terminal: {session, dead}` while the task is still in To do. Claude gets the
environment a terminal of the person would have, not the board's own (`PORT`, pm2's variables, a Claude
session the board was started from), and a UTF-8 `LANG` when the board has none. The answer is
`{ok, session, folder, trusted, keys}` — `trusted: false` means Claude first asks whether to trust the folder. A task the board's Claude already works on, or
is being started on, gets 409 with `running: [keys]`. `KB_CLAUDE_BIN` runs another program in place of `claude`.

**The card's terminal** (`/api/tasks/:key/terminal`). `GET` is the screen of the newest tmux session
tied to the task, row by row as the terminal shows it, with up to 400 lines above; `dead: true` — Claude
has exited (`exit` is its code), the screen stays until `DELETE`. `POST` types `text` as it is (several
lines go in as one bracketed paste; a key name in it is text, not a key) and then presses `key` — one of
`Enter`, `Escape`, `Up`, `Down`, `Left`, `Right`, `Tab`, `BTab`, `BSpace`, `C-c`; 409 once Claude has exited. `links` are the web addresses on
the screen, whole (the screen wraps a long one over rows), the newest last, at most four. `wraps` are the rows of
`screen` (counted from 0) that tmux wrapped onto from the row above — a row printed wider than the window, or one the
window got narrower under; the page joins them back when text is copied from the screen. `cols` is the width
of Claude's window; `GET …/terminal?cols=N` (a whole number, 20–300) first lays the window out N columns wide,
and Claude redraws itself for it — the card sends how many columns its screen holds, so the card keeps its
width and the window follows it. A column or two wider is ignored (two browsers measure the same card 45
and 46 and would take turns), narrower always counts. Of several pages looking at one terminal (a card and a
column of Claude now, two tabs) the narrowest width asked for in the last 3 seconds wins, so they never take turns
laying the window out. A Claude that has exited is not laid out again:
nobody is there to redraw. A session starts 45 columns wide, what a card holds.
Every answer carries `v`, a mark of all it says; `GET …/terminal?seen=<v>` with the mark of the answer the
card already shows gets `{same: true, v}` instead of the same screen again.

`POST …/terminal/message` (`{text}`, at most 14 336 characters) is for text the person did not type while
looking at the screen — a comment of the card. It goes in only while Claude waits at its prompt: not while
it works (a question could open between the look and the Enter) and not while a question is open (the Enter
would answer it). Otherwise 409 with `reason` — `question`, `busy` or `gone` — and nothing is typed. The text
is pasted after the task's key (`KEY: …`), so Claude knows which task it is about and its input never
starts with `!` (shell mode), `/` (a command) or `#`; then Enter.

`task.live` (`{tasks}`) is the whole list from `GET /api/live`, sent when any state changed — the
board checks every 3 s and stays silent while nothing changes.

`limits.updated` carries the body of `GET /api/limits`, sent when a rate-limit figure moves (then without `link`) and when the board is connected to Claude Code or taken off (see below).

## Sync, stats, misc

- `GET /api/sync` — queue state: `{pending, failed, errors, paused, configured, owner, repo, source, last_ok}`. `configured: false` = local-only mode.
- `GET /api/stats` — weekly done/time counters.
- `GET /api/share` — the Wi-Fi door: `{on, wanted, port, error, urls: [{name, url}], qr, guests_n}` (`qr` is an SVG of the first; `error` — `port-busy`/`failed`); through the door — only `{guest: true, on: true}`. `PUT /api/share {on}` opens or closes it — only from the board's page and never by a guest (403). Event `share.updated` carries `{on}` only.
- `GET /api/limits` — `{windows, at, model, link}`: the subscription's rate-limit windows as Claude Code's status line last
  reported them — `five_hour`, `seven_day` and, behind a gateway, `spend_limit`, each `{used, resets_at}` (`used` a
  percentage, `resets_at` Unix seconds) — and `at`, when the board received a reading last. A window whose reset time
  has passed is left out, so `windows: {}` means "no current figures", never zeros. `POST /api/limits` takes
  `{rate_limits, model}` exactly as the status line JSON spells `rate_limits`; `kb statusline` sends it. Readings of
  several sessions are merged — within one window the higher figure is the newer one — and the page is told by the
  `limits.updated` event (the same body as `GET`, without `link`) when a figure moves. `link` says whether the status
  line goes through this board: `connected`, `other` (another board holds it), `manual` (a status line of the
  person's own in a shape connecting does not change), `off`, or `null` when Claude Code's settings.json cannot be
  read. Connecting or taking off (`PUT` / `DELETE /api/claude/hooks`) sends `limits.updated` with `link`.
- **Claude's questions** (the PermissionRequest hook, `kb hook permission`). `POST /api/asks` takes the hook's input as Claude
  Code sends it and answers `{id: null}` when the session has no task on the board (the hook then steps aside), or the request
  `{id, task_id, key, project, session_id, agent_id, kind, tool, input, permission_mode, created_at}` with `kind` one of
  `permission`, `question` (AskUserQuestion), `plan` (ExitPlanMode). `GET /api/asks/:id/wait` is the hook's long poll: `{decision}`
  in the hook's own shape, `{pending: true}` after 25 s, `{gone: true}` when the request is over — except that an answer already delivered is
  given again for a minute, so a poll that crossed the delivery does not lose it. `GET /api/asks` lists what waits;
  `GET /api/asks/:id` says what became of one request — `{state: "pending"}`, `{state: "answered"}` (the board has an answer the
  hook has not taken yet), `{state: "ended", outcome}` for half an hour after it left, or 404 `{reason: "unknown", started_at}` for
  a request the board does not know (`started_at` — when the board started: a request older than that was lost in a restart).
  `POST /api/asks/:id/decision` `{behavior: "allow"|"deny", message?, answers?, annotations?}` is for the board's page — a request without the
  browser's `Origin`, or with a `Sec-Fetch-Site` other than `same-origin`, gets 403 (browsers send no `Sec-Fetch-*` to a plain-http
  LAN address, so there the `Origin` alone is taken). That keeps out web pages, not programs on this computer. `answers` maps each
  question's text to a label or a list of labels; `annotations` maps a question's text to `{notes}` — a note to that answer, passed
  on to Claude Code as its own form sends it (a question the request does not have, or notes that are not text, are left out). 404 — the request is over, 409 — answered already, 425 — sent within half a
  second of the request appearing (a click meant for something else). A 404 or 409 carries `reason`: `board` (an answer from the
  board came first — another tab), `claude` (Claude took an answer in its own window), `expired` (Claude stopped waiting here) or
  `unknown` (with `started_at`, as above). Events: `ask.created` (the request) and `ask.removed` (`{id, task_id, key, outcome}`,
  `outcome` `decided`, `gone` or `expired`).
- **Claude Code on this machine** (Settings → Claude Code). `GET /api/claude` answers in one go what the board needs of
  Claude Code here, found or not: `claude` (`{path, from}` — the program, `from` `KB_CLAUDE_BIN`, `PATH`, `place` (where
  an installer puts it: `~/.local/bin`, `~/.claude/local`, Homebrew) or `app` (the copy of Claude Code inside the Claude
  app on a Mac, its newest version); a
  `KB_CLAUDE_BIN` with no program behind it gives `{path: null, from: "KB_CLAUDE_BIN", set, on_path}` — what the
  variable says, and `claude` on PATH or null), `tmux`
  (`{path}`), `app` (`{path, supported}` — the Claude app, macOS only), `terminal` (`{ok, how}`), `folder` (`{path, from,
  exists}` — the Claude folder, `from` `KB_CLAUDE_DIR`, `CLAUDE_CONFIG_DIR` or `default`), `skill` (`{path, exists,
  symlink, state}` — the board's skill in it; `state` as `package_state` of `GET /api/skills`), `registry` (`{path, exists, sessions_n, live_n}` — Claude Code's registry of live
  sessions), `transcripts` (`{path, exists, projects_n}`), `limits` (`{at, fresh}` — when a reading of the rate limits came last, and whether that was within the last 5 hours)
  and `settings`: `{path, exists, error}` of settings.json — `error` `not-json`, `not-object` or `unreadable` — and, when it
  can be read, `writable` (`why`: `read-only`, `folder` — the folder takes no new file — or `no-folder` — the folder
  `KB_CLAUDE_DIR` names does not exist, and the board does not make it), `seen` (a fingerprint of the file), `status_line` and `hook`
  (what connecting would do to each entry: `already`, `update`, `chain`, `add` or `skip`) and the changes themselves,
  `install` and `uninstall` (`[{part, action, from?, to?}]`, as `local-kanban hooks` prints them). Nothing is started and
  nothing is sent anywhere to answer it. `PUT /api/claude/hooks` connects the board (the status line through `kb
  statusline`, the PermissionRequest hook) and `DELETE` takes it off again, both `{seen}`: the fingerprint of the
  settings.json the change was shown for — a file that changed since is not written (409 `reason: "changed"`). The answer
  is `{ok, written, changes, path, target, kept}` — `kept`, the copy of the previous file in the board's backups. 409
  with `reason` `not-json`, `not-object`, `unreadable`, `read-only`, `folder` or `no-folder`, 500 with `no-copy` or
  `write`: nothing was written, and no copy of the file is kept.
  From the board's page only (as an answer to Claude), 403 otherwise.
- `GET /api/about` — `{version, commit, app_mtime, db_path, data_dir, db_size, uptime, tasks, projects, node, packaged}`.
  `data_dir` is the board's data folder: `local-kanban hooks` and `local-kanban skills` ask for it to keep the copy of a
  file they replace among this board's backups.
  `packaged: true` means the code runs from an npm install rather than a clone; `version` comes from
  `package.json`.
- `GET /api/update-check` — `{update_available, local, remote, branch, tag, dev}`. A clone is compared
  by commit against GitHub, an npm install by version against the registry, and `update_available: null`
  means the check could not be made — never that you are up to date. `?refresh=1` skips the cache
  (throttled to once per 15s).
- `GET /api/whats-new` — `{version, notes, source, url}`. `notes` is the markdown of one changelog
  section, `version` says which release it belongs to. By default the section comes from the
  `CHANGELOG.md` shipped next to the code — the version you are running, read with no network at
  all. `?remote=1` asks the GitHub release page instead, so you can read what changed in a version
  you do not have yet (`source: "github"`, `url` links to that page); if there is no release page,
  no network, or a release with an empty body, it falls back to the local section rather than
  answering nothing. `?refresh=1` skips the one-hour cache on the remote answer (throttled to once per
  15s, like the update check).
- `POST /api/update` — installs the waiting update the way the board was installed (`git pull` and
  then `npm install` for a clone, `npm install -g` for a package) and answers `{ok, how, restart, output, skills}`.
  `skills` — `{refreshed, kept, failed}`: the copied skills that were exactly the package's before the install come
  along with it; a copy that already differed is `kept` as it was (changed by hand, or left behind by an earlier
  update — the board cannot tell which); `failed` — one that could not be written. `restart: "pm2"`
  means the board is exiting on purpose and something will bring it back, so poll until it answers
  again; `restart: "manual"` means the update is in place but starting the board again is up to the
  person. A failure answers 500 with `error` — the line worth showing — plus the full `output` and
  `cmd`, the exact command the board just tried. Show `cmd` to the person: the most common failure
  is no write permission on the global package directory, and that is not something the board can
  fix for itself.

## Examples

Next task in the queue, via curl + python (tolerant parsing):

```bash
curl -s 'http://127.0.0.1:3100/api/tasks?project=demo' -o /tmp/t.json
python3 -c "import json; d=json.JSONDecoder(strict=False).decode(open('/tmp/t.json').read()); \
print([t['key'] for t in d if t['status']=='todo'])"
```

A minimal watcher — notify on every task that reaches review:

```js
// node watch.js
const es = new (require('eventsource'))('http://127.0.0.1:3100/api/events');
es.onmessage = (m) => {
  const ev = JSON.parse(m.data);
  if (ev.type === 'task.updated' && ev.data.status === 'review' && ev.data.prev_status !== 'review') {
    console.log(`ready for review: ${ev.data.key} — ${ev.data.title}`);
  }
};
```

Create a task from a shell script:

```bash
curl -s -X POST http://127.0.0.1:3100/api/tasks \
  -H 'Content-Type: application/json' \
  -d '{"project":"demo","title":"from my script","status":"todo","priority":2}'
```

The reference client is [`bin/kb`](../bin/kb) — a zero-dependency Node script covering the whole workflow.
