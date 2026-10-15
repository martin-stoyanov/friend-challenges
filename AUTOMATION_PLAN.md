# Weekly Challenge Automation

Each week a bot sends Martin a few challenge ideas on Telegram. He picks one,
optionally rewriting the description or other fields, and it goes up on the site
the following Monday. If he doesn't pick by Sunday, idea #1 goes up on its own.

The design, its decisions (D1–D11) and the build steps are in
[`docs/plans/telegram-weekly-proposals.md`](docs/plans/telegram-weekly-proposals.md).
Free-form replies read by Claude (D12–D18) are in
[`docs/plans/telegram-freeform-replies.md`](docs/plans/telegram-freeform-replies.md).

## How a week runs

| When | What happens | Where |
| --- | --- | --- |
| Thursday 12:00 UTC | Claude researches trends and proposes four ideas for the coming Monday. They go to Telegram (one message each, with a Pick button) and are saved to `proposals/<weekId>.json`. | `propose-challenges.yml` |
| Any time | A tap or a reply reaches the Netlify function, which starts the apply workflow. That writes `src/data/challenges.json`, commits, and sends a confirmation once the commit is pushed. Netlify deploys the commit. | `netlify/functions/telegram-webhook.mjs`, `apply-challenge.yml` |
| Sunday 12:00 UTC | If the coming week still has no challenge, #1 is published and Martin is told. With no proposals at all, one is generated directly. | `apply-challenge.yml` (schedule) |
| Monday | The site starts showing the new week. It hides any week dated after the viewer's local today, so a pick made on Thursday stays hidden until Monday. | `src/lib/challenges.ts` |

GitHub has started this repo's scheduled runs up to nine hours late, which is
why the schedules sit at midday, well ahead of Monday.

If the coming week already has a challenge on Thursday (generated or backfilled
by hand), no proposals go out that week and the bot says why.

## Answering in Telegram

- Tap **Pick** under an idea to use it as written.
- Or send `2` to pick #2 as written.
- Or just write what you want, as a reply to an idea or on its own. For
  example: "the kitchen one, but for friends", "2, here's my description: …",
  "make the description shorter", or "none of these, something with music".
  Claude Opus 5.5 reads it (see below), and the confirmation says how it was read.
- Change fields with one line each: `title:`, `emoji:`, `category:` (friend,
  couple or both), `difficulty:` (easy, medium or hard), `players:`, `time:`,
  `link:`. After a number (`2` then the field lines) or in a reply to an idea,
  they're read without Claude.
- Reply to a confirmation to change the same pick again. Picking the same number
  keeps your earlier changes.
- Tap the **🔄 4 more** button under a batch for another one. `/help` shows all
  of this in the chat.

Your own description is published as written. If it breaks a rule in
`writing-style.md`, the confirmation lists what the style check flagged, and
`npm run lint:copy` reports it as a warning rather than a failure.

### Free-form replies (Claude)

Some messages skip Claude and stay instant and free:
- button taps and `/help`;
- a bare number;
- a number followed only by field lines;
- field lines alone in reply to an idea.

Everything else goes to the Apply Challenge workflow, where Claude Opus 5.5
reads it alongside the week's proposals, the current pick and the message you
replied to. That covers anything with prose in it, field lines sent on their
own, and any reply to one of the bot's questions (even a bare number).

- **A pick or a change.** Claude works out the proposal ("the kitchen one") and
  the fields you meant ("couples-only" means category couple). The confirmation
  includes a line built from what was actually applied, for example "I read this
  as: #2 The No-Hands Challenge · for → friends · your description, word for
  word". A field you set to the value it already had says "(already)".
- **Your description.** Claude copies it word for word, and the bot checks that
  it really is your text before using it.
- **A description Claude writes.** This happens only when you ask ("make it
  shorter", "write a fresh one"). It follows `writing-style.md` and gets one
  rewrite if the style check flags it. Unlike your own text, it is linted like
  any generated copy.
- **More ideas.** "None of these, something with music" starts a new batch
  around that theme.
- **Unclear messages.** If Claude isn't sure, you get a question that quotes
  what you wrote. Reply to it, even with just a number, and it's read together
  with your first message.

Accuracy is checked with `node scripts/eval-interpret.mjs` on 24 realistic
messages in `tests/fixtures/interpret-messages.json` (about $1 a run). The latest
run, on 15 Oct 2026, read all 24 as expected.

Only the live week and later weeks can change. A tap on an old week's button is
answered with "in the archive now".

## One-time setup

1. **Anthropic key.** Add `ANTHROPIC_API_KEY` as a GitHub Actions secret
   (repo → Settings → Secrets and variables → Actions). It was never set, so the
   old Monday cron failed on every run; every challenge so far was added by
   hand.
2. **Bot.** In Telegram, message **@BotFather**, send `/newbot`, and keep the
   token it gives you. Send your new bot any message.
3. **Chat id.**
   `TELEGRAM_BOT_TOKEN=<token> node scripts/telegram-setup.mjs chat-id`
4. **Webhook secret.** `node scripts/telegram-setup.mjs secret`
5. **GitHub token for the webhook.** Create a fine-grained personal access token
   (GitHub → Settings → Developer settings) for this repository only, with
   **Actions: Read and write** and nothing else. It can start workflows but
   can't change the repo. Note its expiry date: when it expires, taps get a
   "refused the bot's token" message until it is replaced.
6. **GitHub secrets:** `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`.
7. **Netlify environment variables** (in the site's configuration, under
   Environment variables; the default scope includes Functions):
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
   - `TELEGRAM_WEBHOOK_SECRET`
   - `GITHUB_DISPATCH_TOKEN`
   - `GITHUB_REPO` = `martin-stoyanov/friend-challenges`
8. **Merge to `master`** and let Netlify deploy. Schedules and webhook-started
   runs only use the workflows on `master`, and the function only sees the
   variables from step 7 after a deploy.
9. **Point Telegram at the site:**
   `TELEGRAM_BOT_TOKEN=<token> TELEGRAM_WEBHOOK_SECRET=<secret> node scripts/telegram-setup.mjs webhook https://friendchallenges.martinstoyanov.dev`
10. **Try it.** Actions → Propose Challenges → Run workflow. Pick one on your
    phone and wait for the confirmation.

## When something goes wrong

Every workflow messages the chat when it fails, with a link to the run.

- **No reaction to a tap or reply.** Run `node scripts/telegram-setup.mjs info`
  for Telegram's last delivery error. Then check the `telegram-webhook`
  function's log in the Netlify dashboard: a wrong `TELEGRAM_CHAT_ID` shows up
  there as "Ignored an update from chat …".
- **"GitHub refused the bot's token."** The fine-grained token expired or lacks
  Actions: write. Make a new one (setup step 5), update `GITHUB_DISPATCH_TOKEN`
  on Netlify, and trigger a deploy. The function reads its variables at deploy
  time, and nothing else will redeploy while picks are failing.
- **Doing it by hand.** In the Actions tab:
  - **Apply Challenge** takes a week id, a pick number and an optional
    description.
  - **Propose Challenges** sends a new batch, or another one with mode "more".
    Live batches only go out from here: a local `--propose` without
    `--dry-run` is refused, because a batch that isn't committed has buttons
    that point at nothing.
  - **Weekly Challenge Generator** still generates a challenge directly and
    backfills missing weeks. Filling the coming week this way means Thursday
    sends no proposals for it.
- **Moving the site to another URL.** Run `webhook <new-url>` again.
- **Using another chat.** Run `unhook`, send the bot a message from the new chat,
  run `chat-id`, and put the new id in `TELEGRAM_CHAT_ID` both as a GitHub
  secret and on Netlify (then deploy). Finally run `webhook` again.

## Costs and limits

- About two Claude calls a week for proposals: one call with up to three web
  searches, plus one style-rewrite call when a description needs it. A "more"
  request adds about one more. That model is `claude-sonnet-4-6`
  (`scripts/lib/claude.mjs`).
- One Claude Opus 5.5 call per free-form message, a few cents each, plus one
  more when a description Claude wrote needs a rewrite. Settings are in
  `INTERPRET_OPTIONS` (`scripts/lib/interpret.mjs`).
- The organisation's 30,000 input-tokens-per-minute limit is handled by retries
  that follow `retry-after`.
- Telegram, the Netlify function (a few calls a week) and GitHub Actions on this
  public repository cost nothing.
- GitHub disables scheduled workflows in a public repository after 60 days with
  no activity. The bot's weekly commits keep it active; if they ever stop,
  re-enable the workflows in the Actions tab.
