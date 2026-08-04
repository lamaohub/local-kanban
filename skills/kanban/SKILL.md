---
name: kanban
description: Local kanban task board (the `kb` CLI, localhost:3100). Triggers — "what's on the board", "add a task", "work through project X", "do TIC-3", "take the next task", "accept TIC-3", "send TIC-3 back", "show the board", "block this task". Statuses and comments are mirrored to GitHub automatically (when sync is configured) — you never have to think about it.
---

# Kanban (kb)

Every task lives in a local SQLite database behind the `kb` CLI. GitHub (issues + Projects v2) is a mirror; the sync is optional and runs in the background — ignore it.
Tasks are addressed by key: `TIC-3` (project prefix + number). Case does not matter.

Statuses: `backlog` → `todo` → `prep` → `doing` → `deploy` → `review` → `done` (+ `cancelled`). Blocked is a flag.
`prep` is where you study the task before writing code (reading CLAUDE.md, reading files). The work timer does NOT run there — only `doing` and `deploy` count as work. `kb take` puts a task in `prep`; the moment you start writing code, run `kb mv <key> doing`.

## Commands

```
kb take <proj>                # take the next task from todo → prep; prints the description,
                              # the issue number (for commit messages), the last note from the
                              # human (if the task was sent back, act on it!) and the paths of
                              # attached screenshots as "📎 <path>" — OPEN those with Read,
                              # they are context for the task.
                              # started writing code → kb mv <key> doing.
kb review <key> "note"        # leave a note and move to review. NOT atomic: the note is stored
                              # EVEN IF the move is rejected (backlog and todo cannot go straight
                              # to review — go through prep or doing first; prep→review is fine).
                              # Comments are not de-duplicated, so don't call this on a task that
                              # never went through doing.
kb p                          # projects: slug (PREFIX) b0 t2 pp0 d1 dp0 r1 ✓5 !1  (pp = prep)
kb ls <proj> [-s st] [-a]     # tasks (without -a, backlog/done/cancelled are hidden)
kb show <key>                 # details + issue + latest comments
kb add <proj> "title" [-d "desc"] [-p high|med|low] [-s todo]   # goes to backlog by default!
kb mv <key> todo|prep|doing|deploy|review|done|cancelled
kb done <key> · kb cancel <key> · kb pri <key> high|med|low|none
kb lbl <key> +bug -ui         # labels: bug docs duplicate enhancement ui feature security noclaude ask …
                              # noclaude = done by hand (without Claude) → counted separately on the dashboard
                              # ask = ask clarifying questions and WAIT for an answer before starting
                              #       (see Special cases)
                              # ⚠️ only labels from the palette (LABELS in github.js): kb lbl / kb add
                              #    reject an unknown label immediately (exit code 2). A genuinely new
                              #    label goes into the LABELS palette first, and into this file.
kb desc <key> "description"   # set or overwrite a task description (used when grooming the backlog)
kb note <key> "text"          # a standalone comment (rarely needed — kb review covers it)
kb link <key> <key>           # link two tasks (the board draws a line) · kb unlink to unlink
kb block <key> "why" · kb unblock <key>
kb info <proj>                # path, deploy_skill, server, pm2, domain
kb svc <proj>                 # live status of the project's services (local pm2 or your own PANEL_URL)
kb sync                       # state of the sync queue (or "sync is off" in local-only mode)
```

## A new project goes on the board FIRST (hard rule)

**The moment you create or start a new project — a new folder, site, bot, service — register it
on the board before writing any task or any code for it.** Otherwise the work happens off the
board: it has no task key and no deploy metadata. The board does NOT register projects on its own:
local folders under `LOCAL_ROOT` (`~/claude-projects`) appear in the sidebar with an "+ add" row,
but a project living anywhere else has to be registered by hand.

Register it through the API rather than raw SQL — the API emits an SSE event so the board updates
live, and the GitHub project is provisioned on the first task:

```python
# python3, so quoting doesn't get in the way
import json, urllib.request
body = {
  "slug": "myproj", "name": "myproj.com",
  "path": "<path to the project's code>",
  "deploy_skill": "deploy",        # or empty if there is no deployment
  "server": "<host>", "domain": "myproj.com",
  "category": "<sidebar group>",
  "description": "…",
}
req = urllib.request.Request("http://localhost:3100/api/projects",
    data=json.dumps(body).encode(), method="POST",
    headers={"Content-Type": "application/json"})
print(urllib.request.urlopen(req, timeout=10).read().decode())   # 201 + the object, including prefix
```

Registry fields (PATCHABLE): `name, prefix, path, server_path, deploy_skill, server,
pm2_services, domain, category, description, pinned, archived`. `slug` and `name` are required;
`prefix` (the `PREFIX-N` task key) is generated for you. Edit later with
`PATCH /api/projects/:slug`. When a human registers a project by hand, their path is the
"＋ Add project" wizard at the bottom of the sidebar; the API snippet above is yours.

**Verify it landed (do not skip):** `kb info <slug>` (path/deploy_skill/server/domain filled in),
`kb p | grep <slug>` (visible on the board), `kb sync` (the queue is not stuck). Only then create
tasks (`kb add`) and start working.

## The working loop ("work through project X")

Claude takes a task as far as *review* and stops. Only the user moves anything to done/cancelled.

**When the prompt lists specific keys** (the 📋 button on the "To do" column produces them) those
are SPECIFIC tasks, not a queue. Take each one with `kb show <key>` (NOT `kb take`, which pulls
ONE next task from the project's `todo`) and **move it to prep right away: `kb mv <key> prep`** —
`kb show` does not change the status. If `kb show` printed `> 👤 Send back: …`, the task was
returned: open the `📎` screenshots with Read and act on that note FIRST. Then follow steps 2–6
for each. Use `kb take X` only when asked to "work through project X" without specific keys.

1. `kb take X` — take a task (lands in prep; description and issue are already in the output).
   "empty" → report it and stop. `> 👤 …` is a note from a send-back, act on it first.
   `📎 <path>` — open the screenshot with Read.
2. **HARD RULE — starting a task (never skip, even for a one-line change).** `kb info X` → go to
   `path`. Before any code you MUST read: (a) the project's `CLAUDE.md` if it has one — **and if
   it does not, find where the project keeps its architecture or research document (`README.md`,
   `EXPERIMENTS.md`, `docs/`) and read that; apply the "doc in the same commit" rule to it**;
   (b) the deploy skill at `deploy_skill_path` from `kb info`, if one is set. The matching commit
   rule: **if you change code whose behaviour is documented in the project's `CLAUDE.md`, update
   that section in the SAME commit.** When you edit a document with a script, gate the commit on
   the script succeeding in one chain (`python … && git add … && git commit …`): a script that
   failed on a missing anchor will not stop the next shell command, and the commit would go out
   without the document. Started writing code → `kb mv X doing` (the timer starts).
3. Reference the task's issue in commit messages: `git commit -m "... (#<N>)"` (or `owner/repo#<N>`
   when you commit outside the issues repo) — N comes from the `take`/`show` output. The board
   attaches commit stats to the task on the move to `review`: it looks for a commit that really
   references the issue (`git log -1 --grep=#N`). **When sync is off** (the task has no issue
   number) stats come from the last commit made while the task was in progress, so move the task
   to `doing` BEFORE its commits. Commit with `git -C <path>` or after `cd <path>` — the shell's
   cwd may be outside the repository. A project not under git simply skips the commit step; that
   is normal. **Several tasks touching one file** → either one commit referencing both issues
   (`… (#A, #B)`), or the "revert the hunk → commit → restore it" trick; with 3+ interleaved
   changes, slice the full diff into per-issue patch files and apply them with `git apply`,
   committing in between.
4. If the project has a `deploy_skill`: `kb mv <key> deploy` → run the deployment with that skill →
   step 5. Without a deploy_skill, go straight to step 5. Take the skill from `deploy_skill_path`
   in `kb info` (if the skill is not in the available list, just read its SKILL.md at that path).
   The generic `deploy` skill ships with the board (`skills/deploy/`) and works purely off
   `kb info` data. Production commands (ssh/rsync) will ask for confirmation — that is expected.
5. `kb review <key> "<two plain sentences: 1) what the problem was 2) how you solved it>"` → take
   the next one.
6. Stuck, or the decision is the human's → `kb block <key> "reason"` and move on.
7. At the end, a one-line summary: how many in review, how many blocked.

## Grooming the backlog

Triggered by a prompt like `Groom the backlog [of X] (grooming mode):` with a list of keys (the 📋
button on the "Backlog" column). This is NOT "do the tasks" — no code is written, no statuses move,
**every task stays in the backlog**. The goal is to declutter and prepare.

For each key: 1) `kb show` — title, description, comments; 2) no description → `kb desc <key> "…"`
(one or two sentences, invent nothing); 3) classify: `kb pri` by meaning (unclear — leave it) plus
`kb lbl`; 4) anything unclear → ask via `kb note`, do not guess; 5) do not change the status.
One line of summary at the end.

## User commands for a task in review

- "accept TIC-3" → `kb done TIC-3`.
- "send TIC-3 back: <what's wrong>" → `kb unblock` if needed, `kb mv TIC-3 doing`, fix it, then the
  loop again from step 4. **First REPRODUCE the exact scenario from the note** (curl or a browser,
  following the real flow) and confirm the actual cause — only then fix it. A second attempt at a
  returned task often cures a plausible but wrong cause.
- "cancel TIC-3" → `kb cancel TIC-3`.
- "do TIC-3" (a specific task in any status except done) → `kb show TIC-3` (the `👤` note comes
  first; open `📎` screenshots with Read) and **`kb mv TIC-3 prep` right away**, then steps 2–6.

## Special cases

- **The `ask` label on a task** (visible in `kb show`/`kb take` output) → this is a BLOCKING step:
  study the task in `prep`, then ask your clarifying questions in chat — how you understood the
  task, what you intend to change and where — EVEN IF everything looks obvious, and WAIT for an
  answer. Do not move to `doing` or write code until the human replies.
- **You found an unrelated problem along the way** → do not fix it silently. Create a task
  (`kb add <proj> "..." -d "..."`) and ask in chat: do it now, defer it, or is it for the human.
- **Related tasks solved together** → take both at once (both in doing), fix them in one pass and
  link them with `kb link`.
- **A discussion or question task** (no code): study it in `prep`, put the full answer in
  `kb note <key> "..."`, then `kb mv <key> review`. You write no code and do not move it to done.
- A "check whether the service is alive" task → `kb svc <proj>` (one line per service, no ssh).
- Work time is measured for you: doing/deploy runs the timer, review/done stops it.
- Verifying the result: text and config changes — curl/grep (cheap). Compiled projects — **a build**
  is the cheap check (`cargo build`, `go build ./...`, `tsc --noEmit`, …). **For layout and visual
  changes a screenshot IS the cheap check** — curl and grep never catch a broken layout: serve the
  project from its root and screenshot the page with a headless browser (playwright), on desktop
  (1280) and on mobile (390/360). Mobile "cut off" bugs are horizontal overflow — compare
  `scrollWidth` with `clientWidth` and find elements whose `getBoundingClientRect().right >
  clientWidth`, ignoring those inside an `overflow-x:auto` ancestor.
- **Driving the board's own UI in a browser** (drag & drop, drawer, SSE): use playwright directly,
  `page.goto('http://localhost:3100', { waitUntil: 'domcontentloaded' })` — NOT `networkidle`, the
  SSE connection never closes. Wait for `waitForSelector('#projects .proj')`. **The dashboard is
  what opens on start**, so click a project in the sidebar first, then wait for `.col-body .card`.
  Top-level functions are exposed on `window` (`openDrawer`, `getSetting`, …); `state` is not —
  read state from the DOM. Test mutations on a throwaway task (`POST /api/tasks` → check →
  `DELETE /api/tasks/<key>`); task numbers are not reused, which is normal. For copy buttons, grant
  the clipboard permissions to the browser context or `readText()` silently returns empty. Call
  actions that open a confirmation modal without returning the promise:
  `page.evaluate((k) => { window.deleteTask(k); })` — returning it deadlocks; click the modal as a
  separate step.

## Token rules (hard)

- Never dump the whole board into the chat. One action, one line of `kb` output, no retelling.
- `kb show` only when you need the description in order to work.
- **Going into the database directly: it is `data/kanban.db`, NOT a `kanban.db` in the repo root.**
  Gotcha: `sqlite3 <path>` SILENTLY creates an empty file when nothing is there, so a typo leaves a
  junk 0-byte `.db` in a clean repository. Check the path before running it, and look at
  `git status` after any sqlite session.
- Read task details with `kb show`/`kb take`, not `curl /api/tasks…|jq`: descriptions contain raw
  newlines and a shell JSON parser chokes on them. If you truly need the API, save the response to
  a file and parse it leniently (`python3 … strict=False`).
- **Bulk-create tasks or comments with a script** (`subprocess.run([kb,'add',…])` / `execFile`)
  rather than assembling shell commands: backticks, quotes and newlines get mangled by the shell.
  `kb add` prints the key as the first word of its output — take it and attach labels with `kb lbl`.
- **Bulk moves (`kb mv`/`kb review`) from a script must check `returncode`, not printed output**: a
  rejected move exits non-zero, yet `kb review` still stores the comment. Verify with `kb p` at the
  end that the counts add up.
- Removed an element from a page — verify with grep on **the text or markup**, not the class name
  (the CSS rule of the same name stays behind).
- The review comment is **exactly two plain sentences, no jargon**: (1) what the problem was,
  (2) how you solved it.
- The final chat message is one line per task: `TIC-3 review — summary board is ready`.
- `kb: board is not responding` → restart the board's server (`pm2 restart kanban` / `npm start`),
  wait two seconds and retry once. **Exit codes are distinct: `1` — the board is down (a restart
  and a retry make sense), `2` — the request was rejected (retrying is pointless, read the
  message), `3` — `kb` itself broke (stack trace under `KB_DEBUG=1`). Gate on the code, not on the
  message text.**
- The web board is for the human: http://localhost:3100 — do not open it, do not scrape it.
