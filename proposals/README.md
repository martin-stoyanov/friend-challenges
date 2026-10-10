# Weekly proposals

One file per week, `<weekId>.json` (for example `2026-w43.json`), written by
the bot. Each holds every idea sent to Martin on Telegram for that week, numbered
across batches, and the pick once he makes one (`pick.n`, `pick.source`,
`pick.overrides`).

These files are the record of what was offered and chosen, and the scripts read
them:

- `scripts/apply-choice.mjs` looks up a pick here before publishing it to
  `src/data/challenges.json`.
- `npm run lint:copy` treats a description Martin wrote himself
  (`pick.overrides.description`) as a warning, not a failure.

Don't edit them by hand while a week is open. Changing a number or title breaks
the Pick buttons already in the chat. See `docs/plans/telegram-weekly-proposals.md`.
