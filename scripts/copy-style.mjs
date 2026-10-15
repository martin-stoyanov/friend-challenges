#!/usr/bin/env node

/**
 * Card copy style checker.
 *
 * Mechanical enforcement of the rules in writing-style.md — the ones a regex can
 * actually catch. It is a backstop, not a replacement for reading the guide:
 * the generator injects writing-style.md into the prompt, and this catches the
 * tells that slip through anyway (em dashes, "hilarious", "the goal is to...",
 * uniform sentence length).
 *
 * Usage:
 *   node scripts/copy-style.mjs            # lint every description in challenges.json
 *                                          # (Martin's own Telegram copy only warns)
 *   import { checkDescription } from './copy-style.mjs'
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const STYLE_GUIDE_PATH = path.join(ROOT, 'writing-style.md');
const CHALLENGES_PATH = path.join(ROOT, 'src', 'data', 'challenges.json');
const PROPOSALS_DIR = path.join(ROOT, 'proposals');

/** Reads writing-style.md so callers can paste it into a prompt. */
export function loadStyleGuide() {
  try {
    return fs.readFileSync(STYLE_GUIDE_PATH, 'utf-8');
  } catch {
    return null;
  }
}

export const STYLE_GUIDE_RELATIVE_PATH = 'writing-style.md';

// Words whose only job is telling the reader how to feel. Guide, Part 1:
// "Pre-labeling the fun" and the checklist item about hilarious/comedy gold/epic.
const FEELING_WORDS = [
  /hilarious(ly)?/i,
  /hilarity/i,
  /comedy gold/i,
  /laugh-out-loud/i,
  /\bepic\b/i,
  /\blegendary\b/i,
  /unforgettable/i,
  /\bpure (chaos|comedy|gold)\b/i,
  /for maximum (laughs|hilarity|comedy|reaction|chaos)/i,
];

// Guide, Part 2: vocabulary that skews machine-generated. Two or more in one
// card is the tell, so these are counted rather than banned outright.
const AI_VOCAB = [
  /\bdelve\b/i, /\bunleash\b/i, /\belevate[sd]?\b/i, /\bseamless(ly)?\b/i,
  /\bgame-chang(er|ing)\b/i, /\bnext level\b/i, /\bdive into\b/i, /\bdeep dive\b/i,
  /\bshowcase[sd]?\b/i, /\bcurated\b/i, /\bcrafted\b/i, /\bignite[sd]?\b/i,
  /\bharness(es|ed)?\b/i, /\bunlock[s|ed]?\b/i, /\bsparks?\b/i, /\bfuels?\b/i,
  /\btruly\b/i, /\bgenuinely\b/i, /\bperfect for\b/i,
];

function splitSentences(text) {
  return text
    .split(/(?<=[.!?])\s+/)
    .map(s => s.trim())
    .filter(Boolean);
}

function wordCount(sentence) {
  return sentence.split(/\s+/).filter(Boolean).length;
}

/**
 * Returns an array of { rule, message } violations. Empty array means the copy
 * passes every check this script knows how to run.
 */
export function checkDescription(description) {
  const violations = [];
  const push = (rule, message) => violations.push({ rule, message });

  if (/—|–/.test(description)) {
    push('em-dash', 'Contains an em/en dash. Target is zero — split into two sentences or use a comma.');
  }

  for (const pattern of FEELING_WORDS) {
    const hit = description.match(pattern);
    if (hit) {
      push('pre-labels-the-fun', `Tells the reader how to feel ("${hit[0]}"). Describe what happens instead.`);
    }
  }

  if (/\bthe (goal|aim|objective) is\b/i.test(description)) {
    push('throat-clearing', '"The goal is to..." — state the instruction directly.');
  }

  if (/\bequal parts\b/i.test(description) || /\b\w+ parts \w+ and \w+\b/i.test(description)) {
    push('stock-formula', '"Equal parts X and Y" is a stock summarizing sentence. Replace it with a specific detail.');
  }

  const vocabHits = AI_VOCAB.map(p => description.match(p)).filter(Boolean).map(m => m[0]);
  if (vocabHits.length >= 2) {
    push('ai-vocabulary', `Clusters flagged vocabulary: ${vocabHits.join(', ')}.`);
  }

  const sentences = splitSentences(description);
  const lengths = sentences.map(wordCount);
  if (lengths.length > 1) {
    if (!lengths.some(n => n < 10)) {
      push('uniform-rhythm', 'No sentence under 10 words. Add a short instruction or fragment.');
    }
    if (!lengths.some(n => n > 15)) {
      push('uniform-rhythm', 'No sentence over 15 words. Mix in one longer sentence.');
    }
  }

  // The opposite failure of a wall of 20-word sentences: a card chopped into
  // clipped commands reads just as machine-written. Guide, Part 1: "Don't
  // over-correct into staccato."
  if (lengths.length >= 3) {
    const clipped = lengths.filter(n => n < 7).length;
    let run = 0;
    let longestRun = 0;
    for (const n of lengths) {
      run = n < 7 ? run + 1 : 0;
      longestRun = Math.max(longestRun, run);
    }
    if (clipped > lengths.length / 2 || longestRun >= 3) {
      push('staccato', 'Too many clipped sentences in a row. Fragments are seasoning, not the whole card.');
    }
  }

  // Rule-of-three closer: last sentence ends on "A, B, and C" where the items
  // read as reactions rather than instructions.
  const last = sentences[sentences.length - 1] || '';
  if (/,\s*\w+[\w\s-]*,\s*and\s+[\w\s-]+\.?$/.test(last)) {
    push('rule-of-three-closer', `Closes on a three-item list: "${last}". Pick one concrete outcome instead.`);
  }

  return violations;
}

/** Formats violations for a prompt or a terminal. */
export function formatViolations(violations) {
  return violations.map(v => `- [${v.rule}] ${v.message}`).join('\n');
}

/**
 * Descriptions Martin wrote himself over Telegram, by week id. They are
 * published exactly as written (docs/plans/telegram-weekly-proposals.md, D5),
 * and the week's proposals file records them as pick.overrides.description,
 * with pick.descriptionBy 'martin' (or no descriptionBy, on older picks).
 */
export function readHandWrittenDescriptions(dir = PROPOSALS_DIR) {
  const byWeek = new Map();
  if (!fs.existsSync(dir)) return byWeek;
  for (const name of fs.readdirSync(dir).filter((n) => /^\d{4}-w\d{2}\.json$/.test(n))) {
    // The week comes from the filename, never from inside the file, so a file
    // can only speak for its own week.
    const weekId = name.slice(0, -'.json'.length);
    let file;
    try {
      file = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8'));
    } catch (err) {
      throw new Error(`proposals/${name} is not valid JSON: ${err.message}`);
    }
    const description = file?.pick?.overrides?.description;
    // Only his own words: a description Claude wrote on request is linted like
    // any generated copy. Picks from before descriptionBy existed were his.
    const by = file?.pick?.descriptionBy ?? 'martin';
    if (typeof description === 'string' && by === 'martin') byWeek.set(weekId, description);
  }
  return byWeek;
}

/**
 * Lints every description. A hand-written one that breaks a rule is a warning,
 * not a failure, so Martin's own copy never breaks the build; it only counts as
 * hand-written while the card still carries exactly the text he sent.
 * Returns { failed, warned }, each a list of { challenge, violations }.
 */
export function lintChallenges(challenges, handWritten = new Map()) {
  const failed = [];
  const warned = [];
  for (const challenge of challenges) {
    const violations = checkDescription(challenge.description);
    if (!violations.length) continue;
    const isHandWritten = handWritten.get(challenge.id) === challenge.description;
    (isHandWritten ? warned : failed).push({ challenge, violations });
  }
  return { failed, warned };
}

// CLI: lint every description in challenges.json.
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const challenges = JSON.parse(fs.readFileSync(CHALLENGES_PATH, 'utf-8'));
  const { failed, warned } = lintChallenges(challenges, readHandWrittenDescriptions());

  for (const { challenge, violations } of warned) {
    console.log(`\n⚠️  ${challenge.id} — ${challenge.title} (written by hand, published as written)`);
    console.log(formatViolations(violations));
  }
  for (const { challenge, violations } of failed) {
    console.log(`\n❌ ${challenge.id} — ${challenge.title}`);
    console.log(formatViolations(violations));
  }

  if (failed.length) {
    console.log(`\n${failed.length}/${challenges.length} description(s) violate writing-style.md.`);
    process.exit(1);
  }

  const note = warned.length ? ` (${warned.length} hand-written with warnings)` : '';
  console.log(`✅ All ${challenges.length} descriptions pass writing-style.md checks${note}.`);
}
