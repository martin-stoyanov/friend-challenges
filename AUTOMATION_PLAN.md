# Automatic Weekly Challenge Generation Plan

## Current State

A GitHub Actions workflow (`.github/workflows/weekly-challenge.yml`) is already configured to:
- Run every **Monday at 9:00 UTC** via cron schedule
- Call `scripts/generate-challenge.mjs` which uses the Anthropic Claude API with web search to find trending challenges
- Auto-commit and push the updated `src/data/challenges.json`
- Support manual triggers with backfill, dry-run, and category override options

**Rate-limit handling (added 2026-06-05):** `callClaude` now retries on HTTP 429 / 5xx,
honoring the `retry-after` header (else exponential backoff, up to 5 retries), and
`--backfill` paces requests ~20s apart. This was needed because the org's
30,000 input-tokens/min limit was causing the unattended cron to fail silently on
backfills. Single weekly runs comfortably stay under the limit.

## What's Needed to Go Fully Automatic

### 1. Add `ANTHROPIC_API_KEY` as a GitHub Secret
- Go to **Settings > Secrets and variables > Actions** in the GitHub repo
- Add `ANTHROPIC_API_KEY` with the current API key value
- This is the only blocker — without it, the scheduled workflow will fail silently

### 2. Enable Netlify Auto-Deploy on Push (likely already done)
- Netlify should be configured to auto-deploy on pushes to `main`
- When the bot commits `challenges.json`, Netlify will rebuild and deploy automatically
- Verify: push a small change and confirm Netlify picks it up

### 3. Optional: Add Slack/Email Notification on Failure
- Add a step at the end of the workflow to notify on failure:
```yaml
- name: Notify on failure
  if: failure()
  uses: slackapi/slack-github-action@v1
  with:
    payload: '{"text": "Weekly challenge generation failed! Check: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"}'
  env:
    SLACK_WEBHOOK_URL: ${{ secrets.SLACK_WEBHOOK_URL }}
```

### 4. Optional: Add a Netlify Deploy Trigger Step
If Netlify doesn't auto-deploy on push, add a build hook trigger:
```yaml
- name: Trigger Netlify deploy
  if: ${{ github.event.inputs.dry-run != 'true' }}
  run: curl -X POST -d '{}' ${{ secrets.NETLIFY_BUILD_HOOK }}
```

## Weekly Flow (End-to-End)

```
Monday 9:00 UTC
    |
    v
GitHub Actions cron trigger
    |
    v
generate-challenge.mjs runs
  - Reads existing challenges.json
  - Calls Claude API with web search to find trending challenge
  - Validates JSON response, checks for duplicates
  - Assigns next Monday's date and week ID
    |
    v
Bot commits & pushes updated challenges.json
    |
    v
Netlify auto-deploys from main branch
    |
    v
New challenge live on site
```

## Monitoring & Maintenance

- **Check weekly**: Glance at the Actions tab to confirm runs are green
- **Rate limits**: The Anthropic API has a 30k input-tokens/min limit. The script now retries on 429/5xx (honoring `retry-after`) and paces backfill requests ~20s apart, so the cron survives throttling. The script also retries up to 3 times on JSON parse failures. If you frequently backfill many weeks at once, consider upgrading the API tier to avoid long waits
- **Duplicate detection**: The script checks for fuzzy title matches against all existing challenges
- **Manual override**: Use the `workflow_dispatch` trigger to manually generate, backfill, or dry-run at any time

## Cost Estimate

- ~1 Claude API call per week (with web search tool)
- Estimated cost: < $0.10/week with claude-sonnet-4-6
- Annual cost: ~$5/year
