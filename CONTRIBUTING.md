# Contributing

## Dev setup

```bash
npm install
npm start      # board at http://localhost:3100
node --test    # the DB is isolated via KB_DATA_DIR, your data is safe
```

No build step: vanilla JS frontend served from `public/`, Fastify + better-sqlite3 backend in `src/`. Frontend changes apply on page reload; backend changes need a server restart.

Read [ARCHITECTURE.md](ARCHITECTURE.md) before a first non-trivial change — it covers the design constraints, the status model and the rules that are easy to break from the outside.

## Sending a change

Fork the repository, branch off `main`, and open the pull request against `main` — that is the
branch this repository publishes and the one users install from. `node --test` runs on every pull
request, including from forks, and needs no secrets.

Releases are cut from `main` and tagged `vX.Y.Z`; the tag is what publishes the package to npm.

By sending a change you agree it can be included in the project and distributed under the project's
licence, including a later one. The project is MIT today and there is no plan to change that — but a
contribution that cannot be relicensed freezes the decision for everyone who comes after.

## The schema rule (the one rule that protects user data)

Any change to the database schema **must** ship in the same commit with:

1. a new numbered step at the end of `MIGRATIONS` in `src/db.js` (never edit old steps),
2. the same change in `src/schema.sql` (fresh installs),
3. a check in `test/migrations.test.js` proving old databases survive the migration.

A pre-migration snapshot is taken automatically, but a broken migration still breaks every user's board — tests are not optional here.

## Visual style

The board is minimalist, Linear-style. **One accent color** (`--accent`), calm palette, all colors via CSS tokens (no hardcoded hex — dark themes break otherwise). No multicolored borders, rainbow components, gradient plates or decorative frames. Before adding a visual element, look at how neighbouring blocks are styled and repeat their language.

## UI strings

English is the base language: write the string itself in English inside `tr('…')`. The English text
is also the dictionary key, so a string with no translation stays English rather than leaking another
language into the interface. To translate it, add the pair to `I18N_RU` in `public/js/core.js`.

## Commits

Small, focused commits; message describes the change in plain words. If the change affects architecture documented in `ARCHITECTURE.md`, update that section in the same commit.
