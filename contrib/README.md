# contrib/ — one-off scripts

Scripts that a normal installation does NOT need. They seeded the project registry from a
private monitoring panel and are kept as an example of "how to register projects in bulk".

- `bootstrap.js` — idempotent upsert of the registry from `seed-projects.json` into the board's DB.
- `seed-projects.example.json` — the shape of that file: a JSON array of projects, `slug` and
  `name` required, every other field optional. Copy it to `seed-projects.json` and edit it.
- `seed-projects.json` — your own copy, git-ignored.
- `seed-from-panel.js` — not in git (personal addresses); it drafted the registry from the
  author's HTTP panel. Nothing here needs it: write `seed-projects.json` from the example.

Run them from a clone with `node contrib/bootstrap.js`. They are deliberately not `npm run`
scripts and not part of the published package: `package.json` is the public interface of the
package, and a script listed there that cannot run from an install — because this directory is
not shipped, or because the file it points at was never in git — is a promise to a stranger that
breaks the moment it is taken up.

The normal way to add a project is the board's own "Add project" wizard.
