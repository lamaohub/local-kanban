# Contributing

## Dev setup

```bash
npm install
npm start      # board at http://localhost:3100
npm test       # node --test; the DB is isolated via KB_DATA_DIR, your data is safe
```

No build step: vanilla JS frontend served from `public/`, Fastify + better-sqlite3 backend in `src/`. Frontend changes apply on page reload; backend changes need a server restart.

Read [ARCHITECTURE.md](ARCHITECTURE.md) before a first non-trivial change — it covers the design constraints, the status model and the rules that are easy to break from the outside.

## Branch flow

- `dev` — day-to-day work; PRs target `dev`.
- `main` — stable only: `dev` is merged after it has run without problems, and tagged `vX.Y`. Users update from `main`.

## The schema rule (the one rule that protects user data)

Any change to the database schema **must** ship in the same commit with:

1. a new numbered step at the end of `MIGRATIONS` in `src/db.js` (never edit old steps),
2. the same change in `src/schema.sql` (fresh installs),
3. a check in `test/migrations.test.js` proving old databases survive the migration.

A pre-migration snapshot is taken automatically, but a broken migration still breaks every user's board — tests are not optional here.

## Visual style

The board is minimalist, Linear-style. **One accent color** (`--accent`), calm palette, all colors via CSS tokens (no hardcoded hex — dark themes break otherwise). No multicolored borders, rainbow components, gradient plates or decorative frames. Before adding a visual element, look at how neighbouring blocks are styled and repeat their language.

## UI strings

New user-visible strings go through `tr('…')` with an English pair in `I18N_EN` (top of `public/app.js`).

## Commits

Small, focused commits; message describes the change in plain words. If the change affects architecture documented in `ARCHITECTURE.md`, update that section in the same commit.
