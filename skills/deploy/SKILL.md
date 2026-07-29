---
name: deploy
description: Generic deployment for any project on the kanban board — driven entirely by `kb info <proj>` (path, server, pm2, domain), nothing hardcoded. Triggers — "deploy <project>", "ship it", "update it on the server", and the deploy step of the kanban working loop. Flow: review changes → commit → push → pull on the server → install/build → restart → verify. A local project with no server takes the short branch: commit + restart the local pm2 process.
---

# Generic deploy (driven by kb info)

This skill is not tied to any particular server: everything comes from the board's registry. Does
the project have its own flow? Then it has its own `deploy_skill` in `kb info` — read that
SKILL.md at `deploy_skill_path` and follow it instead of this one.

## 0. The data

```
kb info <proj>   # path (local copy), server (ssh host), server_path (path on the server),
                 # pm2 (process names), domain (for verification)
```
- SSH access uses the alias or address from `server` via `ssh <server>`: keys, users and ports live
  in the user's `~/.ssh/config`. The board stores no secrets.
- No `server` → the project is local: steps 1–2, then straight to 5 (a local restart if it has pm2).

## 1. Review the changes

- `git -C <path> status --porcelain` plus `git -C <path> diff --stat` — what has moved away from HEAD.
- Do not commit junk (temp files, .DS_Store, stray logs).
- If the working tree is clean and everything is already pushed, go straight to step 3.

## 2. Commit + push

- Commit by meaning, with the task's issue number when the deployment is part of the kanban loop.
- `git -C <path> push origin <current branch>`.

## 3. Update on the server

```
ssh <server> "cd <server_path> && git pull --ff-only"
```
- `git pull` failed because of local edits on the server → STOP and tell the human: the server has
  drifted, and overwriting it silently (`reset --hard`) is not allowed. Inspect it with
  `ssh <server> "cd <server_path> && git status --porcelain"`.

## 4. Install / build (by project type — check package.json or the manifest)

- Node: `npm ci || npm install`; if there is a build script, `npm run build`.
- Python: `pip install -r requirements.txt` inside the project's venv.
- Static sites with no build step — skip.

## 5. Restart

- pm2 processes from `kb info`: `ssh <server> "pm2 restart <names>"` (for a local project,
  `pm2 restart <names>` without ssh).
- No pm2 → whatever the project uses (a systemd unit, docker compose). If it is unclear, ask the
  human instead of guessing.

## 6. Verify

- With a `domain`: `curl -sS -o /dev/null -w '%{http_code}' https://<domain>` (or http, whichever
  the project uses) — expect 200/301.
- Check exactly what you changed: the specific page or endpoint, not just the home page.
- pm2: `kb svc <proj>` — processes online, restart counts not climbing.
- Verification failed → discuss the rollback with the human (git revert plus another deploy); never
  roll back silently.

## Rules

- Production commands (ssh, rsync, restart) run with the user's confirmation — that is expected,
  do not work around it.
- The code lives in git: editing directly on the server is forbidden. Spotted drift? Report it,
  do not overwrite it.
- One task, one deployment; related tasks that are ready together ship in a single run.
