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
 *   --propose [N] Generate N candidates (default 4) for the week, save them to
 *                proposals/<weekId>.json and send them to Telegram for a pick
 *                (needs TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID unless --dry-run)
 *   --more       With --propose: add another batch to the week's proposals
 *   --week-id    With --propose: the week as an id (2026-w43) instead of --week
 *   --from-event Read --propose options from the GitHub event that started the
 *                run (propose-challenges.yml): a schedule means a new batch for
 *                the coming week; a workflow_dispatch passes mode, week_id,
 *                count and dry_run as inputs. Inputs are read as data, never
 *                through a shell.
 *   --hint "…"   With --propose: a theme for the ideas, e.g. "something with music"
 *                (from an event: the workflow's hint input)
 *   --batch-out <file>      With --propose: also write the sent batch to <file>
 *   --restore-batch <file>  Put a batch written by --batch-out back into the
 *                week's file, keeping its numbers (after a lost push race)
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
import {
  formatDateLocal,
  getCurrentMonday,
  getMissingWeeks,
  getNextMonday,
  getWeekId,
  weekIdToMonday,
} from './lib/dates.mjs';
import {
  appendBatch,
  createProposals,
  hasFreshBatch,
  MAX_HINT_LENGTH,
  mergeRewrites,
  proposalsPath,
  proposedTitles,
  readProposals,
  restoreBatch,
  selectProposals,
  writeProposals,
} from './lib/proposals.mjs';
import { escapeHtml, formatNotice, sendMessage, sendProposalBatch } from './lib/telegram.mjs';
import { callClaude, sleep } from './lib/claude.mjs';
import {
  buildChallengeRecord,
  CATEGORIES,
  DIFFICULTIES,
  isDuplicateTitle,
  normalizeEnums,
  toTikTokSearchUrl,
  upsertChallenge,
  validateChallenge,
} from './lib/challenge.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHALLENGES_PATH = path.join(__dirname, '..', 'src', 'data', 'challenges.json');

const WEEK_ID = /^\d{4}-w\d{2}$/;

/**
 * A theme for proposals: trimmed, on one line, at most 200 characters, or
 * null when empty. Exits on anything longer: the hint comes from Claude's
 * reading of a message (already short) or a hand-run.
 */
function readHint(value) {
  const hint = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!hint) return null;
  if (hint.length > MAX_HINT_LENGTH) {
    console.error(`❌ The hint must be at most ${MAX_HINT_LENGTH} characters, got ${hint.length}.`);
    process.exit(1);
  }
  return hint;
}

// The event's hint is kept here, beside the flags, never put among them: a
// hint like "--backfill" must stay text, not become a flag.
let eventHint = null;

/**
 * Turns the GitHub event behind --from-event into ordinary --propose flags.
 * Each input is checked before it becomes an argument, so a value like
 * "--backfill" can't smuggle in a flag. The hint never becomes an argument at
 * all: it is kept in eventHint, as text.
 */
function withEventArgs(argv) {
  if (!argv.includes('--from-event')) return argv;
  const out = argv.filter(a => a !== '--from-event');
  const eventName = process.env.GITHUB_EVENT_NAME;
  const inputs = eventName === 'workflow_dispatch' && process.env.GITHUB_EVENT_PATH
    ? JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf-8')).inputs ?? {}
    : {};
  const count = String(inputs.count ?? '').trim();
  out.push('--propose', /^\d+$/.test(count) ? count : '4');
  if (inputs.mode === 'more') out.push('--more');
  const weekId = String(inputs.week_id ?? '').trim();
  if (weekId) {
    if (!WEEK_ID.test(weekId)) {
      console.error(`❌ week_id must look like 2026-w43, got ${JSON.stringify(weekId.slice(0, 40))}`);
      process.exit(1);
    }
    out.push('--week-id', weekId);
  }
  if (inputs.dry_run === true || inputs.dry_run === 'true') out.push('--dry-run');
  eventHint = readHint(inputs.hint);
  return out;
}

// Parse CLI args
const fromEvent = process.argv.includes('--from-event');
const args = withEventArgs(process.argv.slice(2));
const dryRun = args.includes('--dry-run');
const backfill = args.includes('--backfill');
const categoryIdx = args.indexOf('--category');
const forcedCategory = categoryIdx !== -1 ? args[categoryIdx + 1] : null;
const weekIdx = args.indexOf('--week');
const forcedWeek = weekIdx !== -1 ? args[weekIdx + 1] : null;
const proposeIdx = args.indexOf('--propose');
const propose = proposeIdx !== -1;
const proposeCount = /^\d+$/.test(args[proposeIdx + 1] ?? '') ? Number(args[proposeIdx + 1]) : 4;
const more = args.includes('--more');
const weekIdIdx = args.indexOf('--week-id');
const forcedWeekId = weekIdIdx !== -1 ? args[weekIdIdx + 1] : null;
const batchOutIdx = args.indexOf('--batch-out');
const batchOut = batchOutIdx !== -1 ? args[batchOutIdx + 1] : null;
const restoreIdx = args.indexOf('--restore-batch');
const restoreFrom = restoreIdx !== -1 ? args[restoreIdx + 1] : null;
const hintIdx = args.indexOf('--hint');
// A hand-typed --hint needs a theme right after it, not another flag.
if (!fromEvent && hintIdx !== -1 && (!args[hintIdx + 1] || args[hintIdx + 1].startsWith('--'))) {
  console.error('❌ --hint needs a theme after it, e.g. --hint "something with music"');
  process.exit(1);
}
const hint = fromEvent ? eventHint : hintIdx !== -1 ? readHint(args[hintIdx + 1]) : null;
// Titles that were generated but rejected as low quality. They are no longer in
// challenges.json, so the avoid-list can't see them and the model regenerates them.
const rejectedTitles = (process.env.AVOID_TITLES || '')
  .split(',')
  .map(t => t.trim())
  .filter(Boolean);

// Who a challenge is for, as the prompts describe it.
const AUDIENCES = {
  friend: 'friends (group of friends, NOT couples)',
  couple: 'couples (romantic partners)',
  both: 'both friends and couples',
};

// What good fields look like, in plain words. The JSON shape itself is enforced
// by the schemas below (structured outputs), so the prompts no longer spell out
// JSON syntax. Shared by the single-week and proposals prompts so they never
// drift apart.
const CHALLENGE_FIELD_GUIDE = `- title: "The [Name] Challenge".
- description: 4-5 sentences on how to actually play, written to the style guide in the system prompt. Sound like a friend who wants you to try this, not a manual: contractions, an aside, an opinion, a warning about the floor. Describe the mechanics in order so a reader who has never seen the challenge could run it, and introduce anything before you refer to it. Do not tell the reader it is funny. No em dashes, no 'the goal is to...', no three-item adjective closer, and no run of clipped four-word sentences. At least one sentence under 10 words and one over 15. Do not invent props, counts, or rules that are not part of the real challenge.
- category: friend, couple or both.
- difficulty: easy, medium or hard.
- emoji: a single relevant emoji.
- trendSource: where this trend originated or is most popular (e.g. TikTok, Instagram Reels).
- players: number of players needed (e.g. '2', '2+', '3+').
- timeEstimate: estimated time including setup (e.g. '10-15 min', '20-30 min'). Be realistic: factor in prep, explanation, and cleanup.
- exampleUrl: a TikTok SEARCH URL for this challenge so viewers land on real videos. Format: https://www.tiktok.com/search?q=<query> where <query> is the words people actually use to find this challenge (URL-encode spaces as %20). Base the query on a hashtag or phrase you ACTUALLY saw in your web_search results; do NOT invent one. For example: https://www.tiktok.com/search?q=whisper%20challenge. Do NOT use tiktok.com/tag/ URLs: fabricated hashtags dead-end on an empty 'Couldn't find this hashtag' page.
- reasoning: 1-2 sentences explaining why you chose this challenge and why it's trending.`;

// Structured outputs (docs/plans/modern-claude-calls.md, D22): the reply must
// match these, so required fields, category and difficulty values and the
// array of proposals come from the API. validateChallenge and the duplicate
// checks stay as a backstop.
const CHALLENGE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    description: { type: 'string' },
    category: { type: 'string', enum: CATEGORIES },
    difficulty: { type: 'string', enum: DIFFICULTIES },
    emoji: { type: 'string' },
    trendSource: { type: 'string' },
    players: { type: 'string' },
    timeEstimate: { type: 'string' },
    exampleUrl: { type: 'string' },
    reasoning: { type: 'string' },
  },
  required: [
    'title', 'description', 'category', 'difficulty', 'emoji',
    'trendSource', 'players', 'timeEstimate', 'exampleUrl', 'reasoning',
  ],
  additionalProperties: false,
};
const PROPOSALS_SCHEMA = {
  type: 'object',
  properties: { challenges: { type: 'array', items: CHALLENGE_SCHEMA } },
  required: ['challenges'],
  additionalProperties: false,
};
const REWRITES_SCHEMA = {
  type: 'object',
  properties: {
    rewrites: {
      type: 'array',
      items: {
        type: 'object',
        properties: { title: { type: 'string' }, description: { type: 'string' } },
        required: ['title', 'description'],
        additionalProperties: false,
      },
    },
  },
  required: ['rewrites'],
  additionalProperties: false,
};

// Claude Opus 5.5 researches and writes (D21): current web search with dynamic
// filtering, adaptive thinking at effort high, refusal fallbacks.
const RESEARCH_OPTIONS = {
  model: 'claude-opus-5-5',
  searchTool: 'web_search_20260209',
  maxSearches: 3,
  effort: 'high',
  fallbacks: 'default',
  maxTokens: 16000,
};
// Rewriting a description needs no search and less depth.
const REWRITE_OPTIONS = {
  model: 'claude-opus-5-5',
  maxSearches: 0,
  effort: 'medium',
  fallbacks: 'default',
  maxTokens: 8000,
};

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

Be creative and accurate.

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
    ? `The challenge MUST be specifically for: ${AUDIENCES[effectiveCategory] ?? AUDIENCES.both}.`
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

The challenge has these fields:
${CHALLENGE_FIELD_GUIDE}`;

  console.log(`🤖 Generating challenge for week of ${weekOf} (${weekId})...\n`);

  let result;
  let styleFeedback = '';
  let effort = RESEARCH_OPTIONS.effort;
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      result = await callClaude(prompt + styleFeedback, getSystemPrompt(), { ...RESEARCH_OPTIONS, effort, schema: CHALLENGE_SCHEMA });
    } catch (err) {
      if (attempt < maxAttempts && err.message.startsWith('Failed to parse JSON')) {
        // Cut off at max_tokens: think less on the next try rather than repeat it.
        if (err.message.includes('max_tokens')) effort = 'medium';
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

Keep the same challenge and rewrite the description so it passes.`;
  }

  // Validate the result
  result = normalizeEnums(result);
  const problems = validateChallenge(result);
  if (problems.length) {
    for (const problem of problems) console.error(`❌ AI response ${problem}`);
    console.error('   Raw response:', JSON.stringify(result, null, 2));
    return null;
  }

  // Normalize to a TikTok search URL so the link never dead-ends on a fabricated tag.
  result.exampleUrl = toTikTokSearchUrl(result.exampleUrl, result.title);

  // Check for near-duplicates (fuzzy title match)
  const isDuplicate = isDuplicateTitle(result.title, existingTitles);

  if (isDuplicate) {
    console.error(`⚠️  Duplicate detected for "${result.title}" — skipping.`);
    return null;
  }

  const newChallenge = buildChallengeRecord(result, weekId, weekOf);

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

function buildProposalsPrompt({ count, weekOf, existing, alreadyProposed, hint }) {
  const existingLines = existing.map(c => `- "${c.title}" — ${c.description.substring(0, 80)}...`);
  const today = new Date().toISOString().split('T')[0];
  const audienceHint = forcedCategory
    ? `Every challenge MUST be specifically for: ${AUDIENCES[forcedCategory]}.`
    : count > 1
      ? 'Mix the audiences: include at least one challenge for couples (romantic partners) and at least one for a group of friends or for everyone.'
      : 'The challenge can be for friends, couples, or both.';

  return `Today is ${today}. Use the web_search tool to find ${count} different viral friend or couple challenges that are trending on social media (TikTok, Instagram, YouTube Shorts) RIGHT NOW — within the last few weeks. They are candidates for the week of ${weekOf}, and a person will pick one of them.

IMPORTANT — These challenges have ALREADY been used, DO NOT suggest any of these or anything very similar:
${existingLines.join('\n')}
${rejectedTitles.length ? `
These ideas were REJECTED as low quality. Do not suggest them or close variations:
${rejectedTitles.map(t => `- "${t}"`).join('\n')}
` : ''}${alreadyProposed.length ? `
These were already proposed for this week and not picked. Suggest different ones:
${alreadyProposed.map(t => `- "${t}"`).join('\n')}
` : ''}
${audienceHint}

${hint ? `Martin asked for ideas around: "${hint}". Every challenge should fit that theme, but only as a real trend; don't invent a trend to fit it. If few real ones fit, include the closest real trends. If the theme names an audience (couples, friends), that replaces the mix of audiences above.

` : ''}Make them genuinely different from each other: different mechanics, not variations on one idea. ${alreadyProposed.length ? 'Order them best first.' : 'Order them best first; the first one is published automatically if nobody picks.'}

Search first, then give me challenges that are genuinely trending in ${today.substring(0, 7)} — not ones from a prior year.

Put the ${count} challenges in the "challenges" list, best first. Each has these fields:
${CHALLENGE_FIELD_GUIDE}`;
}

// One batched rewrite for every proposal whose description breaks the style
// guide. mergeRewrites matches rewrites by title and keeps one only if it
// breaks fewer rules than the draft did.
async function fixProposalStyle(proposals) {
  const failing = proposals
    .map(proposal => ({ proposal, violations: checkDescription(proposal.description) }))
    .filter(f => f.violations.length > 0);
  if (failing.length === 0) return proposals;

  console.warn(`✍️  ${failing.length} description(s) break ${STYLE_GUIDE_RELATIVE_PATH}; asking for rewrites...`);
  const prompt = `Rewrite the description of each challenge below so it passes the style guide in the system prompt. Keep the same challenge, the same mechanics and the same facts; change only the wording.

${failing.map((f, k) => `${k + 1}. ${f.proposal.title}
Description: "${f.proposal.description}"
It broke these rules:
${formatViolations(f.violations)}`).join('\n\n')}

Put one entry per challenge in "rewrites", with the title exactly as given and the new description.`;

  let rewrites;
  try {
    rewrites = (await callClaude(prompt, getSystemPrompt(), { ...REWRITE_OPTIONS, schema: REWRITES_SCHEMA }))?.rewrites;
  } catch (err) {
    console.warn(`   Rewrite failed (${err.message.split('\n')[0]}); keeping the drafts.`);
    return proposals;
  }

  const { proposals: merged, stillFailing } = mergeRewrites(proposals, rewrites, checkDescription);
  for (const { title, violations } of stillFailing) {
    console.warn(`   "${title}" still breaks the guide; keeping the closer draft:`);
    console.warn(formatViolations(violations));
  }
  return merged;
}

async function generateProposals({ count, weekOf, existing, alreadyProposed, hint }) {
  const prompt = buildProposalsPrompt({ count, weekOf, existing, alreadyProposed, hint });
  const maxAttempts = 3;
  let effort = RESEARCH_OPTIONS.effort;
  let drafts;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      drafts = (await callClaude(prompt, getSystemPrompt(), { ...RESEARCH_OPTIONS, effort, schema: PROPOSALS_SCHEMA }))?.challenges;
    } catch (err) {
      if (attempt < maxAttempts && err.message.startsWith('Failed to parse JSON')) {
        // Cut off at max_tokens: think less on the next try rather than repeat it.
        if (err.message.includes('max_tokens')) effort = 'medium';
        console.warn(`⚠️  JSON parse failed (attempt ${attempt}/${maxAttempts}), retrying...`);
        continue;
      }
      throw err;
    }
    if (Array.isArray(drafts)) break;
    if (attempt === maxAttempts) throw new Error('Claude did not return a list of proposals.');
    console.warn(`⚠️  Response had no list of proposals (attempt ${attempt}/${maxAttempts}), retrying...`);
  }

  // Validate, normalize links and drop repeats, keeping the model's ranking.
  const { kept, dropped } = selectProposals(drafts, {
    avoidTitles: [...existing.map(c => c.title), ...rejectedTitles, ...alreadyProposed],
    count,
  });
  for (const { title, reason } of dropped) console.warn(`⚠️  Dropping "${title}": ${reason}`);

  return fixProposalStyle(kept);
}

async function runPropose(existing) {
  if (backfill) {
    console.error('❌ --propose and --backfill do not combine');
    process.exit(1);
  }
  if (proposeCount < 1 || proposeCount > 8) {
    console.error(`❌ --propose takes 1 to 8 proposals, got ${proposeCount}`);
    process.exit(1);
  }
  const chatId = process.env.TELEGRAM_CHAT_ID;
  // A live batch has to be committed, or its Pick buttons point at nothing
  // (apply-challenge.yml reads proposals from master). Only the workflow commits.
  if (!dryRun && process.env.GITHUB_ACTIONS !== 'true') {
    console.error('❌ Live proposals are sent from GitHub Actions (Actions → Propose Challenges), so the batch gets committed.');
    console.error('   Locally, add --dry-run to preview them.');
    process.exit(1);
  }
  if (!dryRun && (!process.env.TELEGRAM_BOT_TOKEN || !chatId)) {
    console.error('❌ TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required to send proposals (or use --dry-run)');
    process.exit(1);
  }

  const weekOf = forcedWeekId ? weekIdToMonday(forcedWeekId) : forcedWeek || getNextMonday();
  const weekId = getWeekId(weekOf);
  const current = readProposals(weekId);

  // Requests Martin made from the chat get an answer there. Run from the
  // workflow that is not a failure (exit 0); typed by hand it is (exit 1).
  const answer = async (text) => {
    console.error(`❌ ${text}`);
    if (!dryRun) await sendMessage(chatId, formatNotice(`⚠️ ${text}`));
    process.exit(fromEvent ? 0 : 1);
  };

  if (weekOf < getCurrentMonday()) {
    await answer(`${weekId} is in the archive now, so it can't get more ideas.`);
  }
  if (more && !current) {
    await answer(`Nothing has been proposed for ${weekId} yet, so there is nothing to add more ideas to.`);
  }
  // A themed request is deliberate, not a double tap on the button.
  if (more && !hint && hasFreshBatch(current)) {
    // Most likely a double tap. Say so, so the "more ideas coming" toast isn't
    // left hanging.
    console.log(`⏭️  A batch for ${weekId} went out moments ago; not sending another.`);
    if (!dryRun) {
      await sendMessage(chatId, formatNotice('A new batch went out moments ago, just above. Tap more again if you want another one.'));
    }
    return;
  }
  if (!more && current) {
    console.log(`⏭️  ${weekId} already has proposals (${proposalsPath(weekId)}). Use --more for another batch.`);
    return;
  }
  const published = existing.find(c => c.id === weekId);
  if (!more && published) {
    console.log(`⏭️  ${weekId} already has a challenge; nothing to propose.`);
    // Likely generated or backfilled outside Telegram; say so, so a quiet
    // Thursday doesn't look like a broken bot.
    if (fromEvent && !dryRun) {
      await sendMessage(chatId, formatNotice(
        `ℹ️ The week of ${weekOf} already has a challenge ("${published.title}"), added outside Telegram, so there are no proposals this week.`
      ));
    }
    return;
  }

  console.log(`🤖 Proposing ${proposeCount} challenge(s) for week of ${weekOf} (${weekId})${hint ? ` around "${hint}"` : ''}...\n`);
  const drafts = await generateProposals({
    count: proposeCount,
    weekOf,
    existing,
    alreadyProposed: proposedTitles(current),
    hint,
  });
  if (drafts.length === 0) {
    console.error('😕 No usable proposals came back.');
    if (dryRun) process.exit(1);
    const week = `${escapeHtml(weekId)} (${escapeHtml(weekOf)})`;
    await sendMessage(chatId, {
      text: more
        ? `😕 No new ideas for ${week} this time that weren't repeats. Pick one of the earlier ones, or tap more again later.`
        : `😕 I couldn't put together usable ideas for ${week} this time. If nothing is picked by Sunday, the fallback generates one on its own.`,
    });
    // An empty "more" is an answer, not a failure; an empty Thursday batch is.
    process.exit(more ? 0 : 1);
  }

  const { file, added } = appendBatch(current ?? createProposals(weekId, weekOf), drafts);
  for (const p of added) {
    console.log(`#${p.n} ${p.emoji} ${p.title} (${p.category}, ${p.difficulty})`);
    console.log(`   📝 ${p.description}`);
    console.log(`   🎬 ${p.exampleUrl}`);
    if (p.reasoning) console.log(`   💡 ${p.reasoning}`);
  }
  console.log('');

  if (dryRun) {
    console.log(`🏃 Dry run — ${added.length} proposal(s) NOT saved or sent.`);
    return;
  }

  // Send first, save after. sendProposalBatch is all or nothing (it deletes a
  // half-sent batch), so a failed send leaves no file and no live buttons, and
  // a rerun starts clean.
  await sendProposalBatch(chatId, { weekId, weekOf, proposals: added, more, moreCount: proposeCount, hint });
  console.log(`📨 Sent ${added.length} proposal(s) to Telegram.`);
  writeProposals(file);
  console.log(`💾 Saved to ${proposalsPath(weekId)}`);
  if (batchOut) fs.writeFileSync(batchOut, JSON.stringify({ weekId, weekOf, added }));
}

// After a lost push race the workflow resets to the new master and calls this
// to put the batch it already sent back, numbers and all.
function runRestoreBatch() {
  const { weekId, weekOf, added } = JSON.parse(fs.readFileSync(restoreFrom, 'utf-8'));
  if (!WEEK_ID.test(weekId) || !Array.isArray(added)) throw new Error(`${restoreFrom} is not a saved batch`);
  const file = restoreBatch(readProposals(weekId) ?? createProposals(weekId, weekOf), added);
  writeProposals(file);
  console.log(`♻️  Restored ${added.length} proposal(s) to ${proposalsPath(weekId)}`);
}

async function main() {
  if (restoreFrom) {
    runRestoreBatch();
    return;
  }
  console.log('🔥 Friend Challenges — AI Challenge Generator\n');

  // weekOf is compared as a string everywhere (src/lib/challenges.ts), so a
  // non-padded date would hide the week for most of the month.
  if (forcedWeek) {
    const date = new Date(`${forcedWeek}T00:00:00`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(forcedWeek) || formatDateLocal(date) !== forcedWeek) {
      console.error(`❌ --week must be a real date as YYYY-MM-DD, got "${forcedWeek}"`);
      process.exit(1);
    }
    if (date.getDay() !== 1) console.warn(`⚠️  --week ${forcedWeek} is not a Monday.`);
  }
  if (forcedCategory && !CATEGORIES.includes(forcedCategory)) {
    console.error(`❌ --category must be one of ${CATEGORIES.join(', ')}, got "${forcedCategory}"`);
    process.exit(1);
  }
  if (more && !propose) {
    console.error('❌ --more only works with --propose');
    process.exit(1);
  }
  if (hint && !propose) {
    console.error('❌ --hint only works with --propose');
    process.exit(1);
  }
  if (forcedWeekId && (!WEEK_ID.test(forcedWeekId) || forcedWeek)) {
    console.error('❌ --week-id must look like 2026-w43, and does not combine with --week');
    process.exit(1);
  }

  const existing = JSON.parse(fs.readFileSync(CHALLENGES_PATH, 'utf-8'));
  console.log(`📂 Loaded ${existing.length} existing challenges`);
  console.log(`🚫 Will avoid duplicating: ${existing.map(c => c.title).join(', ')}\n`);

  if (propose) {
    await runPropose(existing);
    return;
  }

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
    // A short gap between backfilled weeks. It dates from Sonnet's 30k tokens a
    // minute; Opus 5.5's limit is far higher, and callClaude retries a 429 anyway.
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

  const updated = generated.reduce((list, c) => upsertChallenge(list, c), existing);
  fs.writeFileSync(CHALLENGES_PATH, JSON.stringify(updated, null, 2) + '\n');

  console.log(`💾 Written ${generated.length} challenge(s) to ${CHALLENGES_PATH}`);
  console.log('\n🎉 Done! Commit and push to deploy.');
}

main().catch((err) => {
  console.error('💥 Unexpected error:', err);
  process.exit(1);
});
