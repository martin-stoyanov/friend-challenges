# Plan: weekly challenge proposals over Telegram

Every Thursday a bot texts Martin four candidate challenges on Telegram. He taps one,
or replies to one with his own description and field changes, and that becomes the
next Monday's challenge. If he says nothing by Sunday, proposal #1 is published and
he is told so.

Branch: `telegram-weekly-proposals` (off `origin/master`). Nothing runs on a schedule
until this branch is merged to `master`, because GitHub only runs scheduled and
`repository_dispatch` workflows from the default branch.

## How it fits together

```
Thu 12:00 UTC   GitHub Action: propose-challenges.yml
                  node scripts/generate-challenge.mjs --propose 4
                  → proposals/<weekId>.json committed with [skip netlify]
                  → Telegram: a header + one message per proposal, each with a "Pick #n" button

Any time        You tap "Pick #2", or reply to proposal #2 with your own text
                  → Telegram POSTs to /.netlify/functions/telegram-webhook
                  → function checks the secret header and your chat id, parses the reply,
                    answers "On it", and fires repository_dispatch "apply-choice"
                  → GitHub Action: apply-challenge.yml
                      node scripts/apply-choice.mjs
                      → upserts the week into src/data/challenges.json, commits, pushes
                      → Netlify builds master
                      → Telegram: "Published #2", plus any style-lint warnings

Sun 12:00 UTC   apply-challenge.yml (schedule) → apply-choice.mjs --fallback
                  week already picked → nothing; else publish #1;
                  no proposals at all → generate one the old way

Mon             The site starts showing the new week (it hides weeks dated after
                the viewer's local today)
```

Reply grammar (all optional except the pick):

```
2                              pick #2 as written
2                              pick #2, with this description
Your own description here…
(reply to proposal #2's message) the target comes from the message you replied to
title: The Mirror Challenge     overrides a field; also emoji:, category:, difficulty:,
link: https://…                 players:, time:
/help                          the grammar, sent back
"🔄 4 more" button             another batch (numbered #5–#8), avoiding the earlier ones
```

## Decisions

- **D1 — The gate is this repo's own tooling.** `npm run check` = `tsc -b` + `eslint .`
  + `npm run lint:copy` + `node --test`. No Prettier and no Jest: the repo uses neither
  and the plan adds no dependencies. Node 22.18+ strips TypeScript types natively, so
  tests can import `src/lib/*.ts` directly.
- **D2 — The site hides future weeks.** A pick can land on Thursday for the following
  Monday. Instead of a Monday publish job (one more cron that can fail silently), Home
  and Archive only show challenges whose `weekOf` is on or before the viewer's local
  date. Comparison is on `YYYY-MM-DD` strings in local time, per
  `WEEKOF_DATE_BUG_ANALYSIS.md`.
- **D3 — Proposals live in the repo.** `proposals/<weekId>.json` holds every proposal
  generated for a week, numbered continuously across batches (#1–#4, then #5–#8), plus
  the pick once made. Commits that only touch `proposals/` carry `[skip netlify]` so
  they don't trigger a site build. The repo is public; proposals hold nothing private.
  The chat id and tokens never go in the repo.
- **D4 — The webhook is stateless.** The Netlify Function does not read the repo. The
  target proposal comes from the button's `callback_data` (`pick:<weekId>:<n>`), or
  from the `#<n> · <weekId>` tag line on the message you replied to, or from a leading
  number. With a bare number, the week is the upcoming Monday's.
- **D5 — Martin's text is used verbatim.** A description sent over Telegram is
  published exactly as written. `checkDescription` still runs, and any violations
  come back in the confirmation message with "reply again to replace it". The bot
  never rewrites his copy. A `link:` he sends is kept as given if it is http(s); only
  generated links go through `toTikTokSearchUrl`.
- **D6 — Apply is an upsert keyed by week id.** A later reply for the same week
  replaces the pick. Before Monday that is invisible. After Monday it edits the live
  card, and existing ratings stay attached to the id.
- **D7 — The fallback runs Sunday 12:00 UTC and proposals Thursday 12:00 UTC.** This
  repo's Monday 09:00 cron has started between 14:53 and 18:05 UTC, so schedules
  leave a wide margin. The fallback publishes #1. With no proposals file it runs the
  existing single-challenge generator, so a week is never empty.
- **D8 — GitHub is reached through `repository_dispatch`,** authenticated by a
  fine-grained token limited to this repo with Contents read/write. Workflows read
  the payload from `$GITHUB_EVENT_PATH` in Node. A `${{ github.event.client_payload.* }}`
  expression never appears in a `run:` line, because the payload holds free text.
- **D9 — The webhook trusts only Telegram and Martin.** It requires
  `X-Telegram-Bot-Api-Secret-Token` to equal `TELEGRAM_WEBHOOK_SECRET` (constant-time
  compare; 401 otherwise) and the chat id to equal `TELEGRAM_CHAT_ID`. An update
  from anyone else gets a 200 and is dropped, so Telegram does not retry it.
- **D10 — Every workflow reports its own failure.** A failed run sends the run URL to
  the same Telegram chat. The Monday cron failed silently for five weeks.
- **D11 — The old Monday cron becomes manual-only.** `weekly-challenge.yml` keeps
  backfill, dry-run and category inputs for `workflow_dispatch`, and loses its
  schedule. All three workflows share one `concurrency` group and
  `git pull --rebase` before pushing.

## Steps

### Step 1: A real gate (D1)

- `package.json`: `"test": "node --test 'tests/**/*.test.mjs'"` and
  `"check": "tsc -b && eslint . && npm run lint:copy && npm test"`.
- `eslint.config.js`: a block for `scripts/**/*.mjs`, `netlify/**/*.mjs` and
  `tests/**/*.mjs` with `js.configs.recommended` and `globals.node`.
- Fix the three existing ESLint errors:
  - `EmojiRain.tsx`: build the particles with a lazy `useState` initializer (or at
    module scope) instead of `setState` in an effect.
  - `src/components/ui/{badge,button}.tsx` are shadcn-generated. Turn off
    `react-refresh/only-export-components` for `src/components/ui/**` in the config,
    rather than editing generated files.
- `tests/copy-style.test.mjs`: imports `scripts/copy-style.mjs` and checks one passing and
  one failing description, so `npm test` runs something real.
- Commit this plan file in the same step.

### Step 2: The site hides future weeks (D2)

- `src/lib/challenges.ts`: `toLocalDateString(date)` and
  `getPublishedChallenges(challenges, today = new Date())`, keeping
  `weekOf <= today` (local).
- `Home.tsx`: current, recent and the "done X of Y" total come from published
  challenges only. `Archive.tsx`: lists published challenges only.
- `tests/published.test.mjs`: future week hidden; same-day visible; a date just
  after local midnight; an empty list.

### Step 3: Shared generator library

Pure refactor; `generate-challenge.mjs` behaves exactly as before.

- `scripts/lib/dates.mjs`: `formatDateLocal`, `addDays`, `getNextMonday(now)`,
  `getWeekId`, with `now` injectable.
- `scripts/lib/claude.mjs`: `callClaude` with its 429/5xx retry and JSON extraction.
- `scripts/lib/challenge.mjs`: `REQUIRED_FIELDS`, `validateChallenge`,
  `toTikTokSearchUrl`, `isDuplicateTitle`, `upsertChallenge(list, challenge)` (sorted
  newest first).
- `tests/dates.test.mjs`, `tests/challenge.test.mjs`: next Monday from every
  weekday, ISO week across a year boundary, TikTok URL normalization, duplicate
  detection, and upsert replace-vs-insert.

### Step 4: Telegram client and message format (D10)

- `scripts/lib/telegram.mjs`: `telegramApi(method, body)` using `fetch` and
  `TELEGRAM_BOT_TOKEN`; `escapeHtml`; `formatProposal(p, weekId)`, which returns
  `{ text, reply_markup }` with the tag line `#<n> · <weekId>` and a `Pick #<n>`
  button; `formatHeader(weekId, weekOf, count)` with the reply grammar and a
  `🔄 <count> more` button. Text stays under Telegram's 4096-character limit.
- `scripts/telegram-notify.mjs`: CLI that sends one plain message; workflows use it
  for failures. Exits 0 when the Telegram env is missing, so a notify step never
  hides the real failure.
- `tests/telegram.test.mjs`: escaping, tag line, button data within Telegram's
  64-byte limit, length cap.

### Step 5: Reply parser (D4, D5)

- `scripts/lib/reply.mjs`: `parseUpdate(update, { upcomingWeekId })` returns one of
  `{ type: 'pick', weekId, n, overrides }`, `{ type: 'more', weekId }`,
  `{ type: 'help' }` or `{ type: 'ignore' | 'invalid', reason }`.
  - Sources, in order: callback data, the replied-to message's tag line, a leading
    number (`2`, `#2`, `2:`, `2.`).
  - Override lines are `title:`, `emoji:`, `category:`, `difficulty:`, `players:`,
    `time:` and `link:`, case-insensitive. The rest of the text, trimmed, is the
    description.
  - Enum values are checked here. A `link:` must be http(s).
- `tests/reply.test.mjs`: every source, overrides with and without a description,
  multi-line descriptions, bad category, `javascript:` link, a number with no
  proposals context, edited messages and non-text updates ignored.

### Step 6: `--propose` mode (D3)

- Read the `claude-api` skill before touching the API call. Keep the current model
  and the `web_search_20250305` tool, with `max_uses` raised to 3.
- `scripts/lib/proposals.mjs`: `proposalsPath(weekId)`, `readProposals`,
  `appendBatch(file, proposals)` (continuous numbering), `markPicked`; pure where
  possible.
- `generate-challenge.mjs --propose [N]` (default 4):
  - One Claude call returns an array of N distinct challenges, mixing categories,
    ranked best first.
  - Each is validated. Style violations get one rewrite round, batched in a single
    call. Duplicates of existing titles or of each other are dropped.
  - Writes `proposals/<weekId>.json` and sends the header and one message per
    proposal.
  - `--more` appends a batch for the same week and avoids every earlier title.
    `--dry-run` prints without writing or sending.
  - Fewer than 1 valid proposal exits non-zero.
- `tests/proposals.test.mjs`: numbering across batches, avoid-list built from
  earlier batches, picked marker.

### Step 7: `apply-choice.mjs` and the fallback (D5, D6, D7)

- `scripts/apply-choice.mjs`:
  - Input comes from `$GITHUB_EVENT_PATH` (`client_payload`) or from CLI flags
    (`--week --pick --description --title …`) for manual runs.
  - Resolves the proposal and applies overrides verbatim. It upserts into
    `challenges.json`, marks the proposals file picked, and runs `checkDescription`.
  - Sends a confirmation listing any lint warnings.
  - An unknown week or number sends an error message and exits non-zero.
- `--fallback`: for the upcoming week, does nothing if the week is already in
  `challenges.json`. Otherwise it applies #1 and says so. With no proposals file it
  writes `generate=true` to `$GITHUB_OUTPUT` and exits 0.
- Pure core in `scripts/lib/apply.mjs` (`buildChallenge(proposal, overrides,
  weekId, weekOf)`, `fallbackAction(...)`).
- `tests/apply.test.mjs`: overrides win, the user link is kept as given, a
  generated link is normalized, upsert replaces, all fallback branches.

### Step 8: Netlify webhook (D4, D8, D9)

- `netlify/functions/telegram-webhook.mjs`: Functions 2.0 default export, served at
  `/.netlify/functions/telegram-webhook`. That path is not affected by the SPA
  redirect.
  - Logic lives in `createHandler({ env, fetch })` so tests can inject both.
  - Checks the secret and the chat id, then calls `parseUpdate`.
  - `pick` and `more` fire `repository_dispatch` (`apply-choice` or
    `propose-more`) and acknowledge in Telegram. `help` and `invalid` reply with
    the grammar.
  - Callback taps are answered with `answerCallbackQuery`. The response is always
    200 except for a bad secret.
- `netlify.toml`: `[functions] node_bundler = "esbuild"`.
- `tests/webhook.test.mjs`: bad secret → 401 and no dispatch; stranger → 200 and no
  dispatch; tap → the right dispatch payload; reply with description → payload
  carries it; GitHub error → you are told it failed.

### Step 9: Workflows (D7, D8, D10, D11)

- `.github/workflows/propose-challenges.yml`:
  - Triggers: cron `0 12 * * 4`, `repository_dispatch: [propose-more]`, and
    `workflow_dispatch` (count, dry-run).
  - Runs `--propose` or `--propose --more`, then commits `proposals/` with
    `[skip netlify]`.
- `.github/workflows/apply-challenge.yml`:
  - Triggers: `repository_dispatch: [apply-choice]`, cron `0 12 * * 0` for the
    fallback, and `workflow_dispatch` with week/pick/description inputs for manual
    use.
  - Runs `apply-choice.mjs`; when it reports `generate=true`, runs the generator.
  - Runs `lint:copy` as a report-only step, commits `challenges.json` and
    `proposals/`, and pushes.
- `weekly-challenge.yml`: schedule removed; it stays manual for backfills.
- All three:
  - share `concurrency: { group: challenge-data, cancel-in-progress: false }`;
  - run `git pull --rebase` before pushing;
  - run a final `if: failure()` step with `telegram-notify.mjs` and the run URL.
- Secrets used: `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
- Validate the YAML parses and no `run:` line interpolates `client_payload`.

### Step 10: Setup script and docs

- `scripts/telegram-setup.mjs`: `chat-id` (reads `getUpdates` after you message the
  bot), `webhook <site-url>` (calls `setWebhook` with the secret token, allowed
  updates `message` and `callback_query`, and drops pending updates), `info` and
  `test`.
- `AUTOMATION_PLAN.md`: rewritten for the new flow (its Monday-cron description is
  now wrong).
- `README.md`: a short "Weekly proposals" section pointing to the setup checklist
  below.
- `CLAUDE.md`: one paragraph. Descriptions sent over Telegram are published verbatim
  (D5); `proposals/` is bot-written history.
- `.claude/skills/generate-challenge/SKILL.md`: mention `--propose`.

## Setup checklist (Martin)

1. Add the missing GitHub secret `ANTHROPIC_API_KEY`. The current cron has failed
   every week since Sep 7 without it.
2. In Telegram, message **@BotFather** → `/newbot` → copy the token. Send your new
   bot any message.
3. Run `TELEGRAM_BOT_TOKEN=… node scripts/telegram-setup.mjs chat-id` to get your
   chat id.
4. Pick a random webhook secret (`openssl rand -hex 32`).
5. Create a fine-grained GitHub token for this repo only, with Contents read and
   write.
6. GitHub secrets: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
7. Netlify env vars: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`,
   `TELEGRAM_WEBHOOK_SECRET`, `GITHUB_DISPATCH_TOKEN`, `GITHUB_REPO`
   (`martin-stoyanov/friend-challenges`).
8. Merge the branch to `master` and let Netlify deploy.
9. Run `TELEGRAM_BOT_TOKEN=… TELEGRAM_WEBHOOK_SECRET=… node scripts/telegram-setup.mjs webhook https://friendchallenges.martinstoyanov.dev`.
10. Run **propose-challenges** by hand once from the Actions tab and pick one from
    your phone.

## Status

| Step | Status | Commit |
| --- | --- | --- |
| 1 | done | fcf97fb |
| 2 | done | (this commit) |
| 3 | pending | |
| 4 | pending | |
| 5 | pending | |
| 6 | pending | |
| 7 | pending | |
| 8 | pending | |
| 9 | pending | |
| 10 | pending | |
