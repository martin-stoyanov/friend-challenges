---
name: generate-challenge
description: Generate a single new weekly Friend Challenge with the AI script and add it to src/data/challenges.json. Use when the user wants to create, add, or generate one new weekly challenge for the upcoming Monday. Supports optional --category friend|couple|both and --week YYYY-MM-DD.
---

# Generate a New Weekly Challenge

Generate one new challenge for the next upcoming Monday and add it to `src/data/challenges.json`.

## Prerequisites
- `ANTHROPIC_API_KEY` must be available (stored in `keys.md` locally or as env var).
- **WARNING**: Do NOT `source keys.md` — it contains a command that runs the script. Use `grep` to extract the key.
- Read `writing-style.md` at the repo root before judging or editing any generated description. It is the source of truth for card copy, and the script pastes it into its own system prompt.

## Steps

1. Check `src/data/challenges.json` to see what the latest challenge week is, and confirm which week will be generated next.

2. Run a dry-run first to preview:
```bash
export PATH="$HOME/.nvm/versions/node/v22.19.0/bin:$PATH" && export ANTHROPIC_API_KEY=$(grep '^ANTHROPIC_API_KEY=' keys.md | cut -d'=' -f2 | cut -d' ' -f1) && node scripts/generate-challenge.mjs --dry-run
```

3. If the user is happy with the preview, run the actual generation:
```bash
export PATH="$HOME/.nvm/versions/node/v22.19.0/bin:$PATH" && export ANTHROPIC_API_KEY=$(grep '^ANTHROPIC_API_KEY=' keys.md | cut -d'=' -f2 | cut -d' ' -f1) && node scripts/generate-challenge.mjs
```

4. Verify the updated `src/data/challenges.json` — confirm the new entry is present, correctly formatted, has an `exampleUrl` field pointing to a **TikTok search URL** (format: `https://www.tiktok.com/search?q=<query>` — the script normalizes anything else, since fabricated `tiktok.com/tag/` slugs dead-end on an empty hashtag page), and that the **category balance** is healthy (~40% couple, ~15% friend, ~45% both). **NEVER re-tag existing challenges** to fix the balance — always generate new ones with the right category.

5. Check the description against `writing-style.md`:
```bash
export PATH="$HOME/.nvm/versions/node/v22.19.0/bin:$PATH" && npm run lint:copy
```
The linter only catches mechanical tells (em dashes, "hilarious", "the goal is to...", uniform sentence length). Also read the new description against the checklist at the bottom of `writing-style.md` and rewrite it by hand if it pre-labels the fun or invents details that aren't part of the real challenge.

6. Build to verify nothing is broken:
```bash
export PATH="$HOME/.nvm/versions/node/v22.19.0/bin:$PATH" && npm run build
```

7. Offer to commit and deploy:
```bash
git add src/data/challenges.json && git commit -m "🔥 New weekly challenge [$(date -u +%Y-%m-%d)]" && git push
```

## Challenge Schema
Each generated challenge includes: `id`, `weekOf`, `title`, `description` (written to `writing-style.md`), `category` (friend|couple|both), `difficulty` (easy|medium|hard), `emoji`, `trendSource`, `players`, `timeEstimate`, `exampleUrl` (TikTok search link — format: `https://www.tiktok.com/search?q=<query>`).

The script has **smart category selection**: if no `--category` flag is passed, it analyzes the existing distribution and picks the underrepresented category (targets ~40% couple, ~15% friend, ~45% both).

## Optional Flags
- `--category friend|couple|both` — force a specific category
- `--week YYYY-MM-DD` — override the target week date
