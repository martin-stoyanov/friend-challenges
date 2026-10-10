# Friend Challenges

Weekly viral friend and couple challenges. React 19 + Vite + Tailwind, deployed to Netlify,
challenge data in `src/data/challenges.json`.

## Writing challenge copy

**Read [`writing-style.md`](writing-style.md) in full before writing or editing any
`description` field, card blurb, or other user-facing copy.** It is the source of truth for
the voice: describe the mechanics, then get out of the way. No em dashes, no words that tell
the reader an outcome is funny, no "the goal is to...", no three-item adjective closers.

Two ways to fail, not one. Hype copy is the obvious one. The other is over-correcting into a
flat manual: the card still has to sound like a person who wants you to play it, and every
instruction still has to parse (name a thing before you refer to it, don't cut a clause the
sentence needs). See the second worked example in the guide.

This applies whether the copy is written by hand or by `scripts/generate-challenge.mjs` —
the script pastes the guide into its system prompt and retries drafts that break it.

After touching any description, run:

```bash
npm run lint:copy
```

That checks every description in `src/data/challenges.json` against the mechanical rules in
the guide (`scripts/copy-style.mjs`). It is a backstop, not a substitute for reading the
guide: it cannot catch pre-labeled fun or invented detail, so still run the checklist at the
bottom of `writing-style.md` by eye.

Never invent a prop, number, or rule that isn't actually part of the challenge just to make
a description more concrete.

## Weekly proposals over Telegram

The weekly challenge is picked by Martin from ideas a bot sends him on Telegram
(`AUTOMATION_PLAN.md`, `docs/plans/telegram-weekly-proposals.md`). A description
he writes there is published exactly as he wrote it. Don't rewrite it to the
style guide in `challenges.json` unless he asks. `npm run lint:copy` reports his
own copy as a warning for that reason. `proposals/<weekId>.json` files are
written by the bot. Don't renumber or retitle proposals for an open week: the
Pick buttons in his chat point at those numbers.

## Before committing

Run `npm run check`: `tsc -b`, ESLint, `lint:copy` and the `node:test` suite in `tests/`.
It needs Node 22.18+ (`~/.nvm/versions/node/v22.19.0`). There is no Prettier or Jest in
this repo; don't add them to get a check passing.
