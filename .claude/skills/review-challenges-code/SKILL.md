---
name: review-challenges-code
description: Review Friend Challenges code changes for bugs, security issues, data integrity, and project-convention violations. Use when the user asks to review the diff, check changes before committing, or audit challenges.json data integrity.
---

# Review Friend Challenges Code

You are a senior software engineer performing a thorough code review to identify potential bugs.

**Project context**: Friend Challenges — React 19 + Vite + Tailwind CSS v4 + shadcn/ui app. Static JSON data in `src/data/challenges.json`. AI generation script in `scripts/generate-challenge.mjs` (Claude API). Deployed on Netlify.

Find all potential bugs and code improvements in the code changes. Focus on:
1. Logic errors and incorrect behavior
2. Edge cases that aren't handled
3. Null/undefined reference issues
4. Race conditions or concurrency issues
5. Security vulnerabilities (especially API key exposure, .gitignore gaps — `keys.md` must stay gitignored)
6. Improper resource management or resource leaks
7. API contract violations
8. Tailwind dynamic class interpolation (must use static classes)
9. shadcn/ui usage: ensure `cn()` helper is used, imports use `@/` aliases
10. challenges.json data integrity: valid dates (all `weekOf` must be **Mondays, exactly 7 days apart**), no duplicate IDs, correct weekOf ordering, every entry has an `exampleUrl` field pointing to a **TikTok hashtag URL** (format: `tiktok.com/tag/challengename` — NOT `tiktok.com/search?q=`), healthy category mix (~40% couple, ~15% friend, ~45% both)
11. Violations of existing code patterns or conventions

Make sure to:
1. If exploring the codebase, call multiple tools in parallel for efficiency. Do not spend too much time exploring.
2. Report pre-existing bugs too — maintaining general code quality matters.
3. Do NOT report speculative or low-confidence issues. All conclusions should be based on a complete understanding of the codebase.
4. If given a specific git commit, it may not be checked out and local code state may differ.
