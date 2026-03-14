# Friend Challenges

Weekly viral friend and couple challenges — try it, film it, tag your friends!

## Tech Stack

- **Frontend**: React 19, Vite 7, Tailwind CSS v4, shadcn/ui, Framer Motion
- **Deployment**: Netlify (auto-deploys on push)
- **Challenge Generation**: AI-powered via Claude (Anthropic API)

## Local Development

```bash
npm install
npm run dev
```

## Generating Challenges

New challenges are generated automatically every Monday via GitHub Actions. You can also run the script manually:

```bash
# Generate next week's challenge
node scripts/generate-challenge.mjs

# Backfill missing weeks
node scripts/generate-challenge.mjs --backfill

# Preview without writing to file
node scripts/generate-challenge.mjs --dry-run

# Force a specific category
node scripts/generate-challenge.mjs --category friend
```

Requires an `ANTHROPIC_API_KEY` environment variable.

## Project Structure

- `src/pages/` — Home and Archive pages
- `src/components/` — Reusable UI components
- `src/data/challenges.json` — All challenge data
- `scripts/generate-challenge.mjs` — AI challenge generation script
- `.github/workflows/weekly-challenge.yml` — Weekly automation
