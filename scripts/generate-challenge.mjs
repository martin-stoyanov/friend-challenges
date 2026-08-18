#!/usr/bin/env node

/**
 * AI Challenge Sourcing Script
 * 
 * Uses Anthropic's Claude API to research and generate a new weekly viral challenge.
 * Reads the existing challenges.json to avoid duplicates, then appends the new one.
 *
 * Card copy is governed by writing-style.md at the repo root: the whole guide is
 * pasted into the system prompt, and every generated description is checked
 * against it (scripts/copy-style.mjs) before it is written to challenges.json.
 * 
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... node scripts/generate-challenge.mjs
 *   
 * Options:
 *   --dry-run    Preview the challenge without writing to file
 *   --category   Force a category: friend, couple, or both
 *   --week       Override week date (YYYY-MM-DD), defaults to next Monday
 *   --backfill   Generate challenges for all missing weeks since the last one
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  checkDescription,
  formatViolations,
  loadStyleGuide,
  STYLE_GUIDE_RELATIVE_PATH,
} from './copy-style.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHALLENGES_PATH = path.join(__dirname, '..', 'src', 'data', 'challenges.json');

// Parse CLI args
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const backfill = args.includes('--backfill');
const categoryIdx = args.indexOf('--category');
const forcedCategory = categoryIdx !== -1 ? args[categoryIdx + 1] : null;
const weekIdx = args.indexOf('--week');
const forcedWeek = weekIdx !== -1 ? args[weekIdx + 1] : null;
// Titles that were generated but rejected as low quality. They are no longer in
// challenges.json, so the avoid-list can't see them and the model regenerates them.
const rejectedTitles = (process.env.AVOID_TITLES || '')
  .split(',')
  .map(t => t.trim())
  .filter(Boolean);

function formatDateLocal(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// TikTok /tag/ pages require the exact hashtag to be registered with videos, so a
// model-invented slug dead-ends on "Couldn't find this hashtag". A /search?q= URL
// matches videos by content and never hits that empty state, so we normalize every
// exampleUrl to a search URL. Real search URLs pass through untouched; anything else
// (including /tag/<slug>) becomes a search for the challenge title, which has proper
// word boundaries a concatenated hashtag slug like "squeezeballchallenge" lacks.
function toTikTokSearchUrl(url, title) {
  const titleQuery = title.replace(/^The\s+/i, '').trim();
  const build = (q) => `https://www.tiktok.com/search?q=${encodeURIComponent(q.trim())}`;
  try {
    const u = new URL(url);
    if (/(^|\.)tiktok\.com$/i.test(u.hostname) && u.pathname.startsWith('/search') && u.searchParams.get('q')) {
      return url; // already a usable search URL
    }
  } catch {
    // malformed URL — fall through to title-based query
  }
  return build(titleQuery);
}

function getNextMonday() {
  const now = new Date();
  const day = now.getDay();
  const daysUntilMonday = day === 0 ? 1 : day === 1 ? 0 : 8 - day;
  const nextMonday = new Date(now);
  nextMonday.setDate(now.getDate() + daysUntilMonday);
  return formatDateLocal(nextMonday);
}

function addDays(dateStr, days) {
  const date = new Date(dateStr + 'T00:00:00');
  date.setDate(date.getDate() + days);
  return formatDateLocal(date);
}

function getMissingWeeks(existing) {
  const sorted = [...existing].sort(
    (a, b) => new Date(b.weekOf).getTime() - new Date(a.weekOf).getTime()
  );
  const lastWeekOf = sorted[0]?.weekOf;
  if (!lastWeekOf) return [getNextMonday()];

  const nextMonday = getNextMonday();
  const weeks = [];
  let cursor = addDays(lastWeekOf, 7); // start from the week after the last one

  while (cursor <= nextMonday) {
    weeks.push(cursor);
    cursor = addDays(cursor, 7);
  }

  return weeks;
}

function getWeekId(dateStr) {
  const date = new Date(dateStr + 'T00:00:00');
  // Shift to Thursday of the same ISO week (ISO weeks are defined by their Thursday)
  const thursday = new Date(date);
  thursday.setDate(date.getDate() + (4 - ((date.getDay() + 6) % 7 + 1)));
  const year = thursday.getFullYear();
  const jan1 = new Date(year, 0, 1);
  const weekNum = Math.ceil(((thursday - jan1) / (24 * 60 * 60 * 1000) + 1) / 7);
  return `${year}-w${String(weekNum).padStart(2, '0')}`;
}

async function callClaude(prompt, systemPrompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('❌ ANTHROPIC_API_KEY environment variable is required');
    console.error('   Set it with: ANTHROPIC_API_KEY=sk-ant-... node scripts/generate-challenge.mjs');
    process.exit(1);
  }

  const body = JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: systemPrompt,
    tools: [
      {
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: 1,
      },
    ],
    messages: [
      { role: 'user', content: prompt },
    ],
  });

  // Retry on rate limits (429) and transient server errors (5xx) with backoff.
  // The org's per-minute token bucket refills over ~60s, so we wait it out
  // rather than failing — this keeps unattended runs (e.g. the GitHub cron) reliable.
  const maxRateLimitRetries = 5;
  let response;
  for (let attempt = 0; ; attempt++) {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body,
    });

    if (response.ok) break;

    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt >= maxRateLimitRetries) {
      const error = await response.text();
      throw new Error(`Claude API error (${response.status}): ${error}`);
    }

    // Honor the server's retry-after (seconds) when present, else exponential backoff.
    const retryAfter = Number(response.headers.get('retry-after'));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : Math.min(60_000, 2_000 * 2 ** attempt);
    console.warn(`⏳ ${response.status} from API — waiting ${Math.round(waitMs / 1000)}s before retry (${attempt + 1}/${maxRateLimitRetries})...`);
    await sleep(waitMs);
  }

  const data = await response.json();
  // Response may contain web_search_tool_use / web_search_tool_result blocks — find the final text block
  const textBlock = data.content.find(block => block.type === 'text');
  if (!textBlock) {
    throw new Error(`No text block in Claude response: ${JSON.stringify(data.content)}`);
  }
  const text = textBlock.text;

  // Extract JSON from the response (Claude may wrap it in markdown code fences)
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, text];
  const jsonStr = jsonMatch[1].trim();

  try {
    return JSON.parse(jsonStr);
  } catch {
    throw new Error(`Failed to parse JSON from Claude response:\n${text}`);
  }
}

function getSystemPrompt() {
  const today = new Date().toISOString().split('T')[0];
  const [year] = today.split('-');
  return `You are a viral social media trend researcher specializing in fun friend and couple challenges.
Today's date is ${today}. Always use this as the current date — do NOT reference trends from prior years unless they have had a documented resurgence in ${year}.
You track trends across TikTok, Instagram Reels, YouTube Shorts, and Twitter/X.
Your job is to find REAL challenges that are currently trending or have gone viral recently — meaning in the last 1-3 months relative to ${today}.
Use the web_search tool to look up what is actually trending RIGHT NOW before answering.
You prioritize challenges that are:
- Fun and safe for all ages
- Easy to do at home or anywhere
- Great for filming and sharing on social media
- Genuinely entertaining to watch

Difficulty guidelines:
- "easy": minimal setup, no special skills, anyone can do it immediately (e.g. accent challenge, taste test)
- "medium": some setup/props required OR requires coordination/skill (e.g. blindfold makeup, choreography)
- "hard": significant prep, physical skill, or multiple rounds needed (e.g. elaborate cooking challenge, obstacle courses)

Time estimate guidelines — be realistic, include setup and cleanup:
- Simple verbal/guessing games: 10-15 min
- Challenges needing props or setup: 15-20 min
- Messy or multi-step challenges: 20-30 min
- Complex challenges with prep: 30+ min

You MUST return valid JSON matching the exact schema requested. Be creative and accurate.

${getStyleGuideSection()}`;
}

// The description is the only prose on a challenge card, so it is written to
// writing-style.md. Pasting the whole guide in beats summarizing it: edits to the
// guide take effect on the next run with no change here.
function getStyleGuideSection() {
  const guide = loadStyleGuide();
  if (guide) {
    return `The "description" field is card copy and MUST follow this style guide. Read all of it before writing.

<style-guide file="${STYLE_GUIDE_RELATIVE_PATH}">
${guide}
</style-guide>`;
  }

  // The guide file is missing, so enforce the checklist inline instead.
  console.warn(`⚠️  ${STYLE_GUIDE_RELATIVE_PATH} not found — falling back to the inline checklist.`);
  return `The "description" field is card copy. Write it like a friend describing a game over text:
- Describe the mechanics and let them imply the fun. Never tell the reader an outcome is funny.
- Still sound like a person who wants you to play it. A flat manual fails as hard as an ad.
- Every instruction has to parse. Introduce a thing before you refer to it, and don't cut a clause the sentence needs.
- No em dashes. No "hilarious", "comedy gold", "epic", "unforgettable", "pure chaos", "for maximum laughs".
- No "the goal is to..." — state the instruction directly.
- No "equal parts X and Y" summarizing sentence, and no three-item adjective list closing the card.
- Vary rhythm: at least one sentence under 10 words and one over 15, and no run of clipped commands.
- Never invent a prop, number, or detail that is not actually part of the challenge.`;
}

async function generateOneChallenge(weekOf, existing) {
  const existingTitles = existing.map(c => c.title);
  const existingDescriptions = existing.map(c => c.description.substring(0, 80));
  const weekId = getWeekId(weekOf);

  // Check if this week already exists
  if (existing.some(c => c.id === weekId)) {
    console.log(`⏭️  Skipping ${weekId} (week of ${weekOf}) — already exists.`);
    return null;
  }

  let effectiveCategory = forcedCategory;
  if (!effectiveCategory) {
    // Smart category selection: maintain a healthy mix (target ~40% couple, ~15% friend, ~45% both)
    const counts = { friend: 0, couple: 0, both: 0 };
    for (const c of existing) counts[c.category]++;
    const total = existing.length || 1;
    const coupleRatio = counts.couple / total;
    const friendRatio = counts.friend / total;
    if (coupleRatio < 0.3) effectiveCategory = 'couple';
    else if (friendRatio < 0.1) effectiveCategory = 'friend';
    // otherwise leave null for free choice
  }

  const categoryHint = effectiveCategory 
    ? `The challenge MUST be specifically for: ${effectiveCategory === 'friend' ? 'friends (group of friends, NOT couples)' : effectiveCategory === 'couple' ? 'couples (romantic partners)' : 'both friends and couples'}.`
    : 'The challenge can be for friends, couples, or both — pick whatever is trending hardest right now.';

  const today = new Date().toISOString().split('T')[0];
  const prompt = `Today is ${today}. Use the web_search tool to find ONE viral friend or couple challenge that is currently trending on social media (TikTok, Instagram, YouTube Shorts) RIGHT NOW — within the last few weeks.

IMPORTANT — These challenges have ALREADY been used, DO NOT suggest any of these or anything very similar:
${existingTitles.map((t, i) => `- "${t}" — ${existingDescriptions[i]}...`).join('\n')}
${rejectedTitles.length ? `
These ideas were REJECTED as low quality. Do not suggest them or close variations:
${rejectedTitles.map(t => `- "${t}"`).join('\n')}
` : ''}
${categoryHint}

Search first, then give me a challenge that is genuinely trending in ${today.substring(0, 7)} — not something from a prior year.

IMPORTANT: Your entire response must be ONLY a raw JSON object. No introduction, no explanation, no markdown, no code fences, no text before or after. Start your response with { and end with }.

{
  "title": "The [Name] Challenge",
  "description": "4-5 sentences on how to actually play, written to the style guide in the system prompt. Sound like a friend who wants you to try this, not a manual: contractions, an aside, an opinion, a warning about the floor. Describe the mechanics in order so a reader who has never seen the challenge could run it, and introduce anything before you refer to it. Do not tell the reader it is funny. No em dashes, no 'the goal is to...', no three-item adjective closer, and no run of clipped four-word sentences. At least one sentence under 10 words and one over 15. Do not invent props, counts, or rules that are not part of the real challenge.",
  "category": "friend" | "couple" | "both",
  "difficulty": "easy" | "medium" | "hard",
  "emoji": "a single relevant emoji",
  "trendSource": "where this trend originated or is most popular (e.g. TikTok, Instagram Reels)",
  "players": "number of players needed (e.g. '2', '2+', '3+')",
  "timeEstimate": "estimated time including setup (e.g. '10-15 min', '20-30 min') — be realistic, factor in prep, explanation, and cleanup",
  "exampleUrl": "a TikTok SEARCH URL for this challenge so viewers land on real videos. Format: https://www.tiktok.com/search?q=<query> where <query> is the words people actually use to find this challenge (URL-encode spaces as %20). Base the query on a hashtag or phrase you ACTUALLY saw in your web_search results — do NOT invent one. For example: https://www.tiktok.com/search?q=whisper%20challenge. Do NOT use tiktok.com/tag/ URLs — fabricated hashtags dead-end on an empty 'Couldn't find this hashtag' page.",
  "reasoning": "1-2 sentences explaining why you chose this challenge and why it's trending"
}`;

  console.log(`🤖 Generating challenge for week of ${weekOf} (${weekId})...\n`);

  let result;
  let styleFeedback = '';
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      result = await callClaude(prompt + styleFeedback, getSystemPrompt());
    } catch (err) {
      if (attempt < maxAttempts && err.message.startsWith('Failed to parse JSON')) {
        console.warn(`⚠️  JSON parse failed (attempt ${attempt}/${maxAttempts}), retrying...`);
        continue;
      }
      console.error('❌ Failed to generate challenge:', err.message);
      return null;
    }

    // The style guide is already in the system prompt; this catches what slips
    // through anyway and hands the specific violations back for a rewrite.
    const violations = typeof result?.description === 'string'
      ? checkDescription(result.description)
      : [];
    if (violations.length === 0) break;

    console.warn(`✍️  Description breaks ${STYLE_GUIDE_RELATIVE_PATH} (attempt ${attempt}/${maxAttempts}):`);
    console.warn(formatViolations(violations));

    if (attempt === maxAttempts) {
      console.warn('   Keeping this draft — rewrite the description by hand before shipping.');
      break;
    }

    styleFeedback = `

Your previous description was:
"${result.description}"

It broke these rules from the style guide:
${formatViolations(violations)}

Keep the same challenge and rewrite the description so it passes. Respond with ONLY the raw JSON object again, starting with { and ending with }.`;
  }

  // Validate the result
  const requiredFields = ['title', 'description', 'category', 'difficulty', 'emoji', 'trendSource', 'players', 'timeEstimate', 'exampleUrl'];
  for (const field of requiredFields) {
    if (!result[field]) {
      console.error(`❌ AI response missing required field: ${field}`);
      console.error('   Raw response:', JSON.stringify(result, null, 2));
      return null;
    }
  }

  // Reject non-http(s) URLs so nothing like a javascript:/data: URL lands in
  // challenges.json and later gets rendered as an href on the site.
  if (!/^https?:\/\//i.test(result.exampleUrl)) {
    console.error(`❌ exampleUrl is not an http(s) URL: ${result.exampleUrl}`);
    return null;
  }

  // Normalize to a TikTok search URL so the link never dead-ends on a fabricated tag.
  result.exampleUrl = toTikTokSearchUrl(result.exampleUrl, result.title);

  // Check for near-duplicates (fuzzy title match)
  const normalizedNew = result.title.toLowerCase().replace(/[^a-z]/g, '');
  const isDuplicate = existingTitles.some(t => {
    const normalizedExisting = t.toLowerCase().replace(/[^a-z]/g, '');
    return normalizedNew === normalizedExisting || 
           normalizedNew.includes(normalizedExisting) || 
           normalizedExisting.includes(normalizedNew);
  });

  if (isDuplicate) {
    console.error(`⚠️  Duplicate detected for "${result.title}" — skipping.`);
    return null;
  }

  const newChallenge = {
    id: weekId,
    weekOf,
    title: result.title,
    description: result.description,
    category: result.category,
    difficulty: result.difficulty,
    emoji: result.emoji,
    trendSource: result.trendSource,
    players: result.players,
    timeEstimate: result.timeEstimate,
    exampleUrl: result.exampleUrl,
  };

  console.log(`✅ ${result.emoji} ${result.title}`);
  console.log(`   📝 ${result.description}`);
  console.log(`   🏷️  Category: ${result.category} | Difficulty: ${result.difficulty}`);
  console.log(`   👥 Players: ${result.players} | ⏱️  Time: ${result.timeEstimate}`);
  console.log(`   📱 Source: ${result.trendSource}`);
  if (result.exampleUrl) {
    console.log(`   🎬 Example: ${result.exampleUrl}`);
  }
  if (result.reasoning) {
    console.log(`   💡 Why: ${result.reasoning}`);
  }
  console.log('');

  return newChallenge;
}

async function main() {
  console.log('🔥 Friend Challenges — AI Challenge Generator\n');

  const existing = JSON.parse(fs.readFileSync(CHALLENGES_PATH, 'utf-8'));
  console.log(`📂 Loaded ${existing.length} existing challenges`);
  console.log(`🚫 Will avoid duplicating: ${existing.map(c => c.title).join(', ')}\n`);

  // Determine which weeks to generate
  let weeks;
  if (backfill) {
    weeks = getMissingWeeks(existing);
    if (weeks.length === 0) {
      console.log('✅ No missing weeks — you\'re all caught up!');
      return;
    }
    console.log(`📅 Backfilling ${weeks.length} missing week(s): ${weeks.join(', ')}\n`);
  } else {
    weeks = [forcedWeek || getNextMonday()];
  }

  const generated = [];
  let currentExisting = [...existing];

  for (let i = 0; i < weeks.length; i++) {
    const challenge = await generateOneChallenge(weeks[i], currentExisting);
    if (challenge) {
      generated.push(challenge);
      // Add to running list so next iteration avoids duplicating this one
      currentExisting.unshift(challenge);
    }
    // Space out backfill requests to stay under the per-minute token limit.
    // callClaude already retries on 429, but pausing up front avoids burning retries.
    if (backfill && i < weeks.length - 1) {
      await sleep(20_000);
    }
  }

  if (generated.length === 0) {
    console.log('😕 No new challenges were generated.');
    return;
  }

  if (dryRun) {
    console.log(`🏃 Dry run — ${generated.length} challenge(s) generated but NOT written to file.`);
    console.log('\nJSON preview:');
    console.log(JSON.stringify(generated, null, 2));
    return;
  }

  // Prepend all new challenges (newest first)
  const updated = [...generated.reverse(), ...existing];
  // Sort newest first
  updated.sort((a, b) => new Date(b.weekOf).getTime() - new Date(a.weekOf).getTime());
  fs.writeFileSync(CHALLENGES_PATH, JSON.stringify(updated, null, 2) + '\n');

  console.log(`💾 Written ${generated.length} challenge(s) to ${CHALLENGES_PATH}`);
  console.log('\n🎉 Done! Commit and push to deploy.');
}

main().catch((err) => {
  console.error('💥 Unexpected error:', err);
  process.exit(1);
});
