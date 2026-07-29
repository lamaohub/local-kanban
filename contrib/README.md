# contrib/ — one-off scripts

Scripts that a normal installation does NOT need. They seeded the project registry from a
private monitoring panel and are kept as an example of "how to register projects in bulk".

- `seed-from-panel.js` — not in git (personal addresses); drafts a registry from an HTTP panel.
- `bootstrap.js` — idempotent upsert of the registry from `seed-projects.json` into the board's DB.
- `seed-projects.json` — generated, git-ignored.

The normal way to add a project is the board's own "Add project" wizard.
