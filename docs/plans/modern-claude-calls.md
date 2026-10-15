# Plan: proposals through the current Claude API

Builds on `docs/plans/telegram-weekly-proposals.md` (Steps 3, 6; D1) and
`docs/plans/telegram-freeform-replies.md` (D16).

The weekly proposals, and the generator's single-challenge path used by Sunday's
fallback and backfills, still use the setup from before this work:
- Claude Sonnet 4.6;
- the 2025 web search tool;
- a hand-written `fetch` client with its own retry loop;
- prompts that beg for "ONLY a raw JSON object", followed by fence-stripping and
  retry-on-parse-failure.

This plan moves every Claude call to the official SDK, and the generator to
Claude Opus 5.5 with current features.

Branch: `modern-claude-and-read-as`, shared with `docs/plans/read-as-line.md`.

## Decisions

- **D20 — Every Claude call goes through the official Anthropic SDK.**
  - `scripts/lib/claude.mjs` keeps its `callClaude(prompt, system, options)`
    interface, so callers barely change. Inside, it uses `@anthropic-ai/sdk`
    (`^0.134`) instead of hand-written `fetch`.
  - The SDK's built-in retries replace the custom loop. They follow
    `retry-after` on 429 and retry 5xx and connection errors. Five retries,
    since the org's per-minute token limit is tight.
  - This revises plan A's D1 ("no new dependencies") for this one dependency.
    The workflows that call Claude gain `npm ci`.
- **D21 — The generator runs on Claude Opus 5.5 with current features:**
  - `web_search_20260209`: with dynamic filtering Claude filters results in code
    before they reach its context, at most 3 searches;
  - structured outputs (`output_config.format`): a JSON schema for the
    proposals, the single challenge and the style rewrites, instead of "respond
    with ONLY raw JSON" and parse retries;
  - adaptive thinking at effort `high`, since trend research and card copy
    reward care;
  - server-side refusal fallbacks (`fallbacks: "default"`);
  - `pause_turn` is still resumed (the SDK doesn't do it for a manual call).

  A live probe on 15 Oct 2026 confirmed that web search and a JSON schema work
  together on Opus 5.5.
- **D22 — The schema enforces the shape; the checks stay.** Required fields, the
  category and difficulty values, and the array of proposals come from the
  schema. `validateChallenge`, the duplicate checks, the TikTok link
  normalization and `writing-style.md` stay as a backstop. The prompts keep
  their guidance on what good fields look like, as plain language; the JSON
  boilerplate goes.

## Steps

### Step 19: The SDK client (D20)

- `package.json`: `@anthropic-ai/sdk` `^0.134.0` as a dependency.
- `scripts/lib/claude.mjs`: `callClaude` over `new Anthropic({ apiKey,
  maxRetries: 5, fetch? })`, with the same options as before (model, maxTokens,
  maxSearches, effort, schema, fallbacks).
  - `fallbacks` goes through `client.beta.messages.create` with the beta flag.
  - `pause_turn` is resumed, a refusal throws, text blocks are joined, and a
    schema reply is parsed whole.
  - `extractJson` stays for calls without a schema.
- Tests: the client is given a fake `fetch`. They cover the request body and
  headers, `pause_turn`, refusal, cut-off answers, and that the SDK's retries
  are on.
- Workflows: `npm ci --omit=dev --ignore-scripts` (with the npm cache) before
  any script that calls Claude, in propose and apply. That means runtime
  dependencies only and no install scripts, since those jobs hold a push token.
- The client logs each request and retry at `info`, and keeps the cause and
  request id in its errors. The interpreter gets a 90-second timeout and two
  retries, because Martin is waiting in the chat.

### Step 20: The generator on Opus 5.5 (D21, D22)

- `scripts/generate-challenge.mjs`:
  - `CHALLENGE_SCHEMA` (the record's fields plus `reasoning`, with enums for
    category and difficulty);
  - proposals: `{ challenges: [CHALLENGE_SCHEMA] }`;
  - the single challenge: `CHALLENGE_SCHEMA`;
  - style rewrites: `{ rewrites: [{ title, description }] }`.
  - Calls use `model: 'claude-opus-5-5'`, `web_search_20260209` (3 uses), effort
    `high` and `fallbacks: 'default'`. Rewrites use no tools and effort medium.
  - The prompts lose the "ONLY raw JSON / start with { / no code fences"
    paragraphs and keep the field guidance (`CHALLENGE_JSON_SPEC` becomes plain
    "Fields:" text).
- Tests: the stubbed CLI tests follow the new request shape (model, tool,
  schema). The single path's request is pinned by a new test, replacing the old
  byte-identical parity.

### Step 21: Live checks and docs

- Live, on the real API (a few cents to about $1):
  - `--propose 4 --dry-run` for the coming week;
  - the single-challenge `--dry-run`;
  - `scripts/eval-interpret.mjs` again, since the interpreter's client changed.

  Record what came back here.
- Docs:
  - `AUTOMATION_PLAN.md`: models and costs;
  - `README.md`: the SDK dependency;
  - `CLAUDE.md`: Claude calls go through `scripts/lib/claude.mjs` and the SDK;
  - the generate-challenge and backfill skills: the model.

## Status

| Step | Status | Commit |
| --- | --- | --- |
| 19 | done | 2a6b5fc |
| 20 | done | (this commit) |
| 21 | pending | |
