# Plan: an accurate "I read this as" line

Builds on `docs/plans/telegram-freeform-replies.md` (D18).

When Claude reads a free-form Telegram message, the confirmation includes a line
"I read this as: …". Today Claude writes that line itself, alongside its reading.
It is usually right, but it is free text and can drift from what was applied. For
Martin's real No-Hands reply it said "your edited description", although his text
was used exactly as typed.

Branch: `modern-claude-and-read-as` (off `master` at `f8117e1`), shared with
`docs/plans/modern-claude-calls.md`.

## Decisions

- **D19 — The line is built by code, from the checked reading.** Claude no
  longer writes it: `readAs` leaves the schema and the prompt. After
  `readInterpretation` has checked the reading, `describeReading` writes the line
  from what will actually be applied:
  - the proposal (`#2 The No-Hands Challenge`), and what it replaces when he
    switches from another pick (`instead of #1`);
  - each field this message changes, in his words (`for → friends`,
    `players → 3+`, `link → the one you sent`);
  - the description: `your description, word for word` or `a description I
    wrote`;
  - `(already)` after a field set to the value the card already has;
  - `as proposed` for a new pick with nothing else, `no new changes` when
    re-picking the current one. The card is named by its current title, so a
    re-pick after a rename doesn't show the old one.

  The line is shown whole up to 600 characters, then cut with a visible "…".

  The line can't claim an edit that didn't happen, and it reads the same way
  every time.

## Steps

### Step 17: describeReading (D19)

- `scripts/lib/interpret.mjs`:
  - drop `readAs` from `INTERPRET_SCHEMA` and from the system prompt;
  - add `describeReading({ n, overrides, descriptionBy }, proposals)`;
  - `readInterpretation` returns its line as `readAs`, so callers don't change.
- `scripts/lib/interpret-eval.mjs`: `idealAnswer` without `readAs`.
- `tests/interpret.test.mjs`: each part of the line; a switch from another pick;
  the description wording for each author; a reading with nothing else; the
  schema still requires every property.

### Step 18: Re-run the eval and update the docs

- `node scripts/eval-interpret.mjs` (live, about $1). `CLAUDE.md` requires it
  after any change to `interpret.mjs`. Record the result here.
- `AUTOMATION_PLAN.md`: the example confirmation line.

## Status

| Step | Status | Commit |
| --- | --- | --- |
| 17 | done | (this commit) |
| 18 | pending | |
