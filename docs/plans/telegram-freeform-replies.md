# Plan: Claude reads free-form Telegram replies

Builds on `docs/plans/telegram-weekly-proposals.md` (Steps 1–10, D1–D11).

Today a reply that isn't in the exact format gets "Start with the proposal number".
After this plan Martin can write the way he talks:

- "2, but make it couples-only"
- "the kitchen one, here's my description: …"
- "none of these, something with music"
- "make the description shorter"

Claude works out what he meant, the pick is applied, and the confirmation says how
the message was read.

Branch: `telegram-freeform-replies` (off `master` at `fa115e0`). Like plan A,
nothing changes for Martin until it is merged and Netlify has deployed.

## How it fits together

```
Telegram → Netlify function (scripts/lib/reply.mjs)
  ├─ exact format (button, /help, a bare number, number + field lines)
  │     → apply-challenge.yml with week_id, pick, overrides   (unchanged)
  └─ free prose (a reply with text, or anything the format can't read)
        → apply-challenge.yml with week_id, message, reply_n
              → apply-choice.mjs → interpret.mjs → Claude Opus 5.5 (JSON schema)
                    ├─ pick     → existing applyPick → commit → confirmation
                    │             ("I read this as: …")
                    ├─ more     → starts propose-challenges.yml with a hint
                    ├─ help     → the reply guide
                    └─ clarify  → a question back in the chat; nothing applied
```

## Decisions

- **D12 — Claude runs in the apply workflow, not the Netlify function.** The
  workflow already holds the Anthropic key, has no 10-second limit, and can read
  the week's proposals file. The function only forwards the raw text.
- **D13 — Exact-format messages stay deterministic; prose goes to Claude.** These
  keep today's instant, free path:
  - button taps and `/commands`;
  - a bare number, alone or in a reply;
  - a message made only of a number and `field:` lines.

  Anything with free prose goes to Claude, including a reply to a proposal with
  text, which until now was always taken as the description.
- **D14 — Martin's words are never changed without his asking.** Claude reports
  where a description came from.
  - `martin`: it must appear word for word in his message, apart from leading and
    trailing whitespace. Otherwise nothing is applied and he gets a question.
  - `claude`: Claude wrote it, which is allowed only when he asked ("make it
    shorter", "write one about …"). It is written to `writing-style.md` and
    style-checked, with one rewrite round if it breaks a rule.

  The pick records `descriptionBy`. Only Martin's own text is exempt in
  `npm run lint:copy`, where it is reported as a warning instead of failing; copy
  Claude writes is linted like any generated copy.
- **D15 — When unsure, ask.** Claude can answer `clarify` with one short question
  instead of guessing. Nothing is applied.
  - The question quotes what Martin wrote and ends with a question tag line,
    `? · <week>`. Any reply to it goes to Claude, even a bare number, so his first
    message isn't lost.
  - The webhook forwards the text of the message he replied to (`reply_text`), so
    Claude reads his answer together with its own question and his earlier
    words.
- **D16 — Claude Opus 5.5 over the existing raw-`fetch` client.**
  - The interpreter reuses `scripts/lib/claude.mjs`, which gains options for the
    model, effort, a JSON schema (`output_config.format`) and server-side refusal
    fallbacks (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`).
  - Thinking stays on (it can't be turned off on Opus 5.5), at effort `medium`,
    with no web search. `max_tokens` is 16000, because thinking counts toward it.
  - The generator's own request stays byte-identical.
- **D17 — "More" can carry a theme.** An interpreted "more" starts
  `propose-challenges.yml` with `mode=more`, the week and a `hint`, using the
  workflow's own `GITHUB_TOKEN`. GitHub allows `workflow_dispatch` from it; the
  apply workflow gets `actions: write`. The hint goes into the proposals prompt.
- **D18 — Every interpreted pick says how it was read.** The confirmation gains a
  line such as "I read this as: #2, category → couple, your description". When
  Claude wrote the description, the line says so. A misread is fixed by replying to
  the confirmation.

## Steps

### Step 11: Claude options for Opus 5.5 (D16)

- Read the `claude-api` skill first.
- `scripts/lib/claude.mjs`: `callClaude(prompt, system, { model, effort, schema,
  fallbacks, maxSearches, maxTokens, … })`.
  - `schema` sends `output_config.format = { type: "json_schema", schema }`.
  - `effort` sends `output_config.effort`.
  - `fallbacks: 'default'` adds the beta header and parameter.
  - Thinking blocks are skipped when reading the answer, and a refusal still
    throws.
  - Defaults are unchanged, so the generator's request stays byte-identical.
- `tests/claude.test.mjs`:
  - the default body unchanged;
  - an Opus request carries model, effort, format, fallbacks and the header, and
    no tools;
  - a response with thinking blocks parses.

### Step 12: The interpreter (D13–D15, D18)

- `scripts/lib/interpret.mjs`:
  - `INTERPRET_SCHEMA`: `action` (pick | more | help | clarify), `n`, `fields`
    (title, emoji, category, difficulty, players, time, link), `description`,
    `descriptionBy` (martin | claude | none), `hint`, `question` and `readAs` (a
    one-line summary). All fields are required, nullable where they don't apply,
    with `additionalProperties: false`.
  - `buildInterpretRequest({ message, replyN, replyText, proposals, published, styleGuide })`
    returns the system prompt and user prompt. It gives Claude the week's
    proposals, what is published for that week, the proposal or confirmation
    replied to, and the message.
  - `readInterpretation(answer, context)` validates the answer:
    - `n` must exist;
    - a `martin` description must be his own words (`findVerbatim`: curly and
      straight quotes count as equal, word boundaries, at least three words),
      and his own span of the message is what's stored;
    - a link must appear in his message;
    - a description and its author must come together;
    - fields go through `validateOverrides`;
    - a `claude` description is allowed only when the action is a pick.

    It returns `{ type: 'pick', n, overrides, descriptionBy, readAs }`,
    `{ type: 'more', hint }`, `{ type: 'help' }` or `{ type: 'clarify', question }`.
    A failed check becomes a `clarify` with a reason.
- `tests/interpret.test.mjs`: prompt contents; each action; every guardrail; a
  paraphrased "martin" description is refused.

### Step 13: Routing prose to Claude (D12, D13)

- `scripts/lib/reply.mjs`: `parseUpdate` returns
  `{ type: 'freeform', weekId, replyN, replyText, text }` for prose:
  - a reply with text;
  - a number followed by text;
  - anything the format can't read.

  Bare numbers, field-only messages, buttons and `/commands` behave as before.
  The text goes through verbatim.
- `netlify/functions/telegram-webhook.mjs`: `freeform` starts
  `apply-challenge.yml` with `week_id`, `message`, `reply_n` (empty when none),
  `reply_text` (the replied-to message's text, capped at 1500 characters, empty
  when none) and `source=message`, then acknowledges with 👍. A new
  `readQuestionTag` reads the question tag (`? · <week>`, made by `questionTag`),
  and any reply to a question is prose, even a bare number. A body with any
  non-field line is prose, even if another of its lines is a malformed field.
- `.github/workflows/apply-challenge.yml`: new `message`, `reply_n` and
  `reply_text` inputs, and `actions: write` for D17.
- Tests: the parser cases that change, the webhook payload for prose, and
  unchanged behaviour for the exact format.

### Step 14: Applying an interpreted message (D14, D15, D17, D18)

- `scripts/apply-choice.mjs`: when the event carries `message`:
  1. it reads the week's proposals and what's published;
  2. it calls Opus 5.5 through `interpret.mjs`, once per workflow run. The
     reading is cached in `$RUNNER_TEMP` and reused when a lost push race makes
     the workflow apply again, so a retry neither pays twice nor reads the
     message differently;
  3. for a pick, it runs the existing `applyPick`. A Claude-written description
     gets `checkDescription` and one rewrite round, and `descriptionBy` is
     recorded in the pick;
  4. `more` starts `propose-challenges.yml` (mode `more`, `week_id`, `hint`)
     through the GitHub API with `GITHUB_TOKEN`;
  5. `help` sends the guide, and `clarify` sends the question ending with the
     week's tag line.

  Exit codes follow Step 7: an answered message exits 0.
- `formatConfirmation` gains an optional `readAs` line.
- `scripts/copy-style.mjs`: exempts a description only when the pick says
  `descriptionBy: 'martin'`. Older picks without the field count as Martin's.
- Tests: CLI runs with a stubbed Claude for every action, the guardrails end to
  end, the lint exemption, and the `more` dispatch request.

### Step 15: "More" with a theme (D17)

- `propose-challenges.yml`: optional `hint` input.
- `generate-challenge.mjs`: `--from-event` reads the hint as text and never puts it
  among the flags, so a hint like `--backfill` stays a theme. A hand-run uses
  `--hint "…"`. The hint is trimmed, kept on one line and capped at 200
  characters. The proposals prompt asks for ideas that fit it, only as real
  trends; a named audience replaces the usual mix. A themed "more" isn't held
  back as a double tap, and the batch header names the theme.
- Tests: the hint reaches the prompt and the header; a flag-like hint stays text;
  an overlong hint is refused.

### Step 16: Evaluation and docs

- `tests/fixtures/interpret-messages.json`: about 20 realistic messages, each with
  its context and the expected reading.
- `scripts/eval-interpret.mjs`: runs them against the live model and reports
  agreement. It is opt-in, needs `ANTHROPIC_API_KEY`, and costs about $1 a run.
  Run it once and record the result here.
- Docs:
  - the reply guide gains "or just write what you want";
  - `AUTOMATION_PLAN.md` explains free-form replies, questions and themes;
  - `CLAUDE.md`: copy Claude writes on request follows `writing-style.md`, and
    only Martin's own words are exempt.

## Status

| Step | Status | Commit |
| --- | --- | --- |
| 11 | done | 7b6eb6b |
| 12 | done | 847dd5f |
| 13 | done | 3788b11 |
| 14 | done | 875f626 |
| 15 | done | (this commit) |
| 16 | pending | |
