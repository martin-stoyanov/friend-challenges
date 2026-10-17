# Friend Challenges

Weekly viral friend and couple challenges — try it, film it, tag your friends!

## Tech Stack

- **Frontend**: React 19, Vite 7, Tailwind CSS v4, shadcn/ui, Framer Motion
- **Deployment**: Netlify (auto-deploys on push)
- **Challenge Generation**: Claude Opus 5.5 through the official Anthropic SDK (`@anthropic-ai/sdk`)

## Local Development

```bash
npm install
npm run dev
```

Before committing, run the full gate (typecheck, ESLint, the copy lint and the tests in
`tests/`). It needs Node 22.18 or newer:

```bash
npm run check
```

## Weekly Challenges

Every Thursday a bot sends a few challenge ideas on Telegram. A tap or a reply
picks one (optionally with your own description), and it goes up on the site the
following Monday. If nothing is picked by Sunday, the first idea goes up on its
own. How it works, setup and troubleshooting:
[`AUTOMATION_PLAN.md`](AUTOMATION_PLAN.md).

The generator can also be run by hand:

```bash
# Preview 4 proposals for the coming week (a live batch is sent from
# Actions → Propose Challenges, so that it gets committed)
node scripts/generate-challenge.mjs --propose 4 --dry-run

# Generate next week's challenge directly
node scripts/generate-challenge.mjs

# Backfill missing weeks
node scripts/generate-challenge.mjs --backfill

# Preview without writing to file
node scripts/generate-challenge.mjs --dry-run

# Force a specific category
node scripts/generate-challenge.mjs --category friend
```

Requires `npm install` (the scripts call Claude through `@anthropic-ai/sdk`) and an
`ANTHROPIC_API_KEY` environment variable. A run takes a minute or two and usually costs
about $0.50; see "Costs and limits" in `AUTOMATION_PLAN.md`.

## Challenge Copy

All card copy follows [`writing-style.md`](writing-style.md). Read it before writing or
rewriting any description by hand. The generator pastes the whole guide into its system
prompt and rejects drafts that break it, so edits to the guide take effect on the next run.

Check every description in `src/data/challenges.json` against the guide:

```bash
npm run lint:copy
```

## Project Structure

- `src/pages/` — Home and Archive pages
- `src/components/` — Reusable UI components
- `src/data/challenges.json` — All challenge data
- `scripts/generate-challenge.mjs` — AI challenge generation, direct or as proposals (`--propose`)
- `scripts/apply-choice.mjs` — applies a pick, or the Sunday fallback, to `challenges.json`
- `scripts/telegram-setup.mjs`, `scripts/telegram-notify.mjs` — bot setup and notices
- `scripts/lib/` — shared pieces: dates, Claude calls (`claude.mjs`, the only code that talks to the API), Telegram, the reply parser, the free-form reply interpreter, proposals
- `scripts/eval-interpret.mjs` — live accuracy check of the interpreter on `tests/fixtures/interpret-messages.json`
- `scripts/copy-style.mjs` — writing-style.md checker (used by the generator and `npm run lint:copy`)
- `netlify/functions/telegram-webhook.mjs` — receives Telegram taps and replies
- `proposals/` — one file per week: the ideas sent and the pick
- `tests/` — `node:test` suite (`npm test`)
- `writing-style.md` — voice and copy rules for every challenge description
- `.github/workflows/` — `propose-challenges.yml` (Thursday), `apply-challenge.yml` (picks and the Sunday fallback), `weekly-challenge.yml` (manual generate and backfill)
