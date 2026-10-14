# Weekly proposals

One file per week, `<weekId>.json` (for example `2026-w43.json`), written by
the bot. Each holds every idea sent to Martin on Telegram for that week, numbered
across batches, and the pick once he makes one (`pick.n`, `pick.source`,
`pick.overrides`).

These files are the record of what was offered and chosen, and the scripts read
them:

- `scripts/apply-choice.mjs` looks up a pick here before publishing it to
  `src/data/challenges.json`.
- `npm run lint:copy` treats a description Martin wrote himself as a warning,
  not a failure: `pick.overrides.description` when `pick.descriptionBy` is
  `martin` (or missing, on older picks). One Claude wrote on his request
  (`descriptionBy: claude`) is linted like any generated copy.

Don't edit them by hand while a week is open. Changing a number or title breaks
the Pick buttons already in the chat. See `docs/plans/telegram-weekly-proposals.md`.
