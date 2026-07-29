## What & why

## Checklist

- [ ] `npm test` passes
- [ ] Schema changed? → numbered migration in `src/db.js` + `src/schema.sql` + check in `test/migrations.test.js` (see CONTRIBUTING)
- [ ] New user-visible strings go through `tr('…')` with an `I18N_EN` pair
- [ ] Architecture affected? → matching section of `ARCHITECTURE.md` updated in the same commit
