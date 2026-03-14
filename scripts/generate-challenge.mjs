#!/usr/bin/env node

/**
 * AI Challenge Sourcing Script
 * 
 * Uses Anthropic's Claude API to research and generate a new weekly viral challenge.
 * Reads the existing challenges.json to avoid duplicates, then appends the new one.
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

function getNextMonday() {
  const now = new Date();
  const day = now.getDay();
  const daysUntilMonday = day === 0 ? 1 : day === 1 ? 0 : 8 - day;
  const nextMonday = new Date(now);
  nextMonday.setDate(now.getDate() + daysUntilMonday);
  return nextMonday.toISOString().split('T')[0];
}

function addDays(dateStr, days) {
  const date = new Date(dateStr + 'T00:00:00');
  date.setDate(date.getDate() + days);
  return date.toISOString().split('T')[0];
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

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
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
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Claude API error (${response.status}): ${error}`);
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

You MUST return valid JSON matching the exact schema requested. Be creative and accurate.`;
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

  const categoryHint = forcedCategory 
    ? `The challenge MUST be specifically for: ${forcedCategory === 'friend' ? 'friends' : forcedCategory === 'couple' ? 'couples' : 'both friends and couples'}.`
    : 'The challenge can be for friends, couples, or both — pick whatever is trending hardest right now.';

  const today = new Date().toISOString().split('T')[0];
  const prompt = `Today is ${today}. Use the web_search tool to find ONE viral friend or couple challenge that is currently trending on social media (TikTok, Instagram, YouTube Shorts) RIGHT NOW — within the last few weeks.

IMPORTANT — These challenges have ALREADY been used, DO NOT suggest any of these or anything very similar:
${existingTitles.map((t, i) => `- "${t}" — ${existingDescriptions[i]}...`).join('\n')}

${categoryHint}

Search first, then give me a challenge that is genuinely trending in ${today.substring(0, 7)} — not something from a prior year.

IMPORTANT: Your entire response must be ONLY a raw JSON object. No introduction, no explanation, no markdown, no code fences, no text before or after. Start your response with { and end with }.

{
  "title": "The [Name] Challenge",
  "description": "A 2-3 sentence fun description of how to do the challenge. Be specific about the rules and what makes it funny/entertaining.",
  "category": "friend" | "couple" | "both",
  "difficulty": "easy" | "medium" | "hard",
  "emoji": "a single relevant emoji",
  "trendSource": "where this trend originated or is most popular (e.g. TikTok, Instagram Reels)",
  "players": "number of players needed (e.g. '2', '2+', '3+')",
  "timeEstimate": "estimated time (e.g. '10 min', '15-20 min')",
  "reasoning": "1-2 sentences explaining why you chose this challenge and why it's trending"
}`;

  console.log(`🤖 Generating challenge for week of ${weekOf} (${weekId})...\n`);

  let result;
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      result = await callClaude(prompt, getSystemPrompt());
      break;
    } catch (err) {
      if (attempt < maxAttempts && err.message.startsWith('Failed to parse JSON')) {
        console.warn(`⚠️  JSON parse failed (attempt ${attempt}/${maxAttempts}), retrying...`);
        continue;
      }
      console.error('❌ Failed to generate challenge:', err.message);
      return null;
    }
  }

  // Validate the result
  const requiredFields = ['title', 'description', 'category', 'difficulty', 'emoji', 'trendSource', 'players', 'timeEstimate'];
  for (const field of requiredFields) {
    if (!result[field]) {
      console.error(`❌ AI response missing required field: ${field}`);
      console.error('   Raw response:', JSON.stringify(result, null, 2));
      return null;
    }
  }

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
  };

  console.log(`✅ ${result.emoji} ${result.title}`);
  console.log(`   📝 ${result.description}`);
  console.log(`   🏷️  Category: ${result.category} | Difficulty: ${result.difficulty}`);
  console.log(`   👥 Players: ${result.players} | ⏱️  Time: ${result.timeEstimate}`);
  console.log(`   📱 Source: ${result.trendSource}`);
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

  for (const weekOf of weeks) {
    const challenge = await generateOneChallenge(weekOf, currentExisting);
    if (challenge) {
      generated.push(challenge);
      // Add to running list so next iteration avoids duplicating this one
      currentExisting.unshift(challenge);
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
