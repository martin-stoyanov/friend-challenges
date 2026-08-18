---
name: backfill-challenges
description: Backfill all missing weekly Friend Challenges between the last entry in src/data/challenges.json and the upcoming Monday. Use when the site hasn't been updated in a while and multiple weeks are missing, or the user asks to catch up / backfill / fill in missing challenges.
---

# Backfill Missing Challenges

Generate challenges for all missing weeks between the last entry in `src/data/challenges.json` and the upcoming Monday.

## Prerequisites
- `ANTHROPIC_API_KEY` must be available (stored in `keys.md` locally or as env var).
- **WARNING**: Do NOT `source keys.md` — it contains a command that runs the script. Use `grep` to extract the key.
- Read `writing-style.md` at the repo root before judging or editing any generated description. It is the source of truth for card copy, and the script pastes it into its own system prompt.

## Steps

1. Check how many weeks are missing by reading `src/data/challenges.json` and comparing the latest `weekOf` date to today's date. Report the gap to the user.

2. Run a dry-run to preview what will be generated:
```bash
export PATH="$HOME/.nvm/versions/node/v22.19.0/bin:$PATH" && export ANTHROPIC_API_KEY=$(grep '^ANTHROPIC_API_KEY=' keys.md | cut -d'=' -f2 | cut -d' ' -f1) && node scripts/generate-challenge.mjs --backfill --dry-run
```

3. If the dry-run looks good, ask the user for confirmation, then run the actual backfill:
```bash
export PATH="$HOME/.nvm/versions/node/v22.19.0/bin:$PATH" && export ANTHROPIC_API_KEY=$(grep '^ANTHROPIC_API_KEY=' keys.md | cut -d'=' -f2 | cut -d' ' -f1) && node scripts/generate-challenge.mjs --backfill
```

4. Verify the updated `src/data/challenges.json` — confirm:
   - New entries were added and sorted newest-first.
   - All `weekOf` dates are **Mondays, exactly 7 days apart** (timezone bug was fixed — see `WEEKOF_DATE_BUG_ANALYSIS.md`).
   - Each entry has an `exampleUrl` field pointing to a **TikTok search URL** (format: `https://www.tiktok.com/search?q=<query>` — the script normalizes anything else, since fabricated `tiktok.com/tag/` slugs dead-end on an empty hashtag page).
   - Every new description passes `npm run lint:copy` and reads clean against the checklist at the bottom of `writing-style.md`. Backfills generate several descriptions in a row, so watch for all of them landing in the same shape.
   - **Category balance**: target ~40% couple, ~15% friend, ~45% both. The script auto-selects underrepresented categories when no `--category` flag is passed. **NEVER re-tag existing challenges** to fix the balance — always generate new ones with the right category.

5. Build the project to make sure nothing is broken:
```bash
export PATH="$HOME/.nvm/versions/node/v22.19.0/bin:$PATH" && npm run build
```

6. Offer to commit and deploy:
```bash
git add src/data/challenges.json && git commit -m "🔥 Backfill challenges" && git push
```

## Challenge Schema
Each generated challenge includes: `id`, `weekOf`, `title`, `description` (written to `writing-style.md`), `category` (friend|couple|both), `difficulty` (easy|medium|hard), `emoji`, `trendSource`, `players`, `timeEstimate`, `exampleUrl` (TikTok search link — format: `https://www.tiktok.com/search?q=<query>`).

## Rate Limits
The Anthropic API may rate-limit if generating many challenges at once. If you see 429 errors, wait 60 seconds and retry.
