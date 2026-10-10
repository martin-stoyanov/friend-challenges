#!/usr/bin/env node

/**
 * Applies a pick, or Sunday's fallback, to src/data/challenges.json and records
 * it in proposals/<weekId>.json. Normally run by
 * .github/workflows/apply-challenge.yml.
 *
 * Usage:
 *   node scripts/apply-choice.mjs
 *       Reads the pick from $GITHUB_EVENT_PATH: a repository_dispatch from the
 *       Telegram webhook, or a workflow_dispatch run by hand.
 *   node scripts/apply-choice.mjs --pick 2 [--week-id 2026-w43] [--description "…"]
 *       [--title "…"] [--emoji "…"] [--category …] [--difficulty …]
 *       [--players "…"] [--time "…"] [--link "…"]
 *       Applies a pick from the command line. The week defaults to the coming one.
 *   node scripts/apply-choice.mjs --fallback
 *       Sunday: if the coming week has no challenge, applies the recorded pick
 *       or #1. With nothing proposed, writes generate=true to $GITHUB_OUTPUT so
 *       the workflow runs the generator instead.
 *
 *   --message-out <file>  Write the confirmation to <file> instead of sending
 *                         it, so the workflow sends it only after the commit
 *                         is pushed.
 *
 * Exit codes: 0 when the pick was applied, or when a pick sent from Telegram
 * was wrong and Martin has been told why (an answer, not a failure); 1 for
 * everything else, including a bad pick given on the command line.
 *
 * $GITHUB_OUTPUT gets applied=true when challenges.json changed (the workflow
 * then commits and sends the confirmation) and generate=true when the
 * fallback found nothing proposed.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { checkDescription } from './copy-style.mjs';
import { applyPick, changedFields, fallbackAction, parsePickEvent } from './lib/apply.mjs';
import { formatDateLocal, getNextMonday, getWeekId } from './lib/dates.mjs';
import { readProposals, writeProposals } from './lib/proposals.mjs';
import { formatConfirmation, formatNotice, sendMessage } from './lib/telegram.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHALLENGES_PATH = path.join(__dirname, '..', 'src', 'data', 'challenges.json');

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const fallback = args.includes('--fallback');
const messageOut = flag('--message-out');

const CLI_OVERRIDES = {
  '--description': 'description',
  '--title': 'title',
  '--emoji': 'emoji',
  '--category': 'category',
  '--difficulty': 'difficulty',
  '--players': 'players',
  '--time': 'timeEstimate',
  '--link': 'exampleUrl',
};

/** Sends a message now, or just logs it when Telegram isn't configured. */
async function tell(message) {
  const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = process.env;
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log(`(Telegram not configured; not sent)\n${message.text}`);
    return;
  }
  await sendMessage(TELEGRAM_CHAT_ID, message);
}

/** The confirmation: to --message-out for the workflow to send after pushing, else now. */
async function deliver(message) {
  if (messageOut) {
    fs.writeFileSync(messageOut, JSON.stringify(message));
    console.log(`📝 Confirmation written to ${messageOut}`);
    return;
  }
  await tell(message);
}

function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
}

// Local date, as everywhere else (see scripts/lib/dates.mjs); the runner is UTC.
const isLive = (weekOf, now = new Date()) => weekOf <= formatDateLocal(now);

function readChallenges() {
  return JSON.parse(fs.readFileSync(CHALLENGES_PATH, 'utf-8'));
}

function writeChallenges(challenges) {
  fs.writeFileSync(CHALLENGES_PATH, JSON.stringify(challenges, null, 2) + '\n');
}

/** The pick request, from flags or from the GitHub event. */
function readRequest() {
  if (args.includes('--pick')) {
    const overrides = {};
    for (const [name, field] of Object.entries(CLI_OVERRIDES)) {
      const value = flag(name);
      if (value !== undefined) overrides[field] = value;
    }
    // Same validation as a dispatch payload.
    const parsed = parsePickEvent('repository_dispatch', {
      client_payload: {
        weekId: flag('--week-id') ?? getWeekId(getNextMonday()),
        n: Number(flag('--pick')),
        overrides,
        source: 'manual',
      },
    });
    return { ...parsed, fromTelegram: false };
  }

  const eventPath = process.env.GITHUB_EVENT_PATH;
  const eventName = process.env.GITHUB_EVENT_NAME;
  if (!eventPath || !eventName) {
    return { error: 'No pick given. Use --pick N, --fallback, or run from a GitHub event.', fromTelegram: false };
  }
  const event = JSON.parse(fs.readFileSync(eventPath, 'utf-8'));
  return { ...parsePickEvent(eventName, event), fromTelegram: eventName === 'repository_dispatch' };
}

/** Writes the applied pick and delivers its confirmation. */
async function save(result, { n, weekId, fallbackPick = false }) {
  writeChallenges(result.challenges);
  writeProposals(result.proposals);
  setOutput('applied', 'true');
  const { challenge, overrides } = result;
  const violations = checkDescription(challenge.description);
  console.log(`✅ ${weekId}: #${n} ${challenge.emoji} ${challenge.title}`);
  if (violations.length) console.warn(`⚠️  Description breaks ${violations.length} style rule(s); published as written.`);
  await deliver(formatConfirmation({
    challenge,
    n,
    weekId,
    changed: changedFields(overrides),
    violations,
    fallback: fallbackPick,
    live: isLive(challenge.weekOf),
  }));
}

async function runPick() {
  const request = readRequest();
  const answer = async (problem) => {
    console.error(`❌ ${problem}`);
    if (request.fromTelegram) {
      await tell(formatNotice(`⚠️ ${problem}${/[.!?]$/.test(problem) ? '' : '.'} Send /help for the reply format.`));
      return; // told Martin; nothing broke
    }
    process.exitCode = 1;
  };

  if (request.error) return answer(request.error);
  const { weekId, n, overrides, source } = request;
  const result = applyPick({
    challenges: readChallenges(),
    proposals: readProposals(weekId),
    weekId,
    n,
    overrides,
    source,
  });
  if (result.error) return answer(result.error);
  await save(result, { n, weekId });
}

async function runFallback() {
  const weekOf = getNextMonday();
  const weekId = getWeekId(weekOf);
  const challenges = readChallenges();
  const proposals = readProposals(weekId);
  const next = fallbackAction({ weekId, challenges, proposals });

  if (next.action === 'none') {
    console.log(`✅ ${weekId} already has a challenge; nothing to do.`);
    return;
  }
  if (next.action === 'generate') {
    console.log(`⚠️  Nothing was proposed for ${weekId}; the workflow will generate one.`);
    setOutput('generate', 'true');
    return;
  }

  const result = applyPick({
    challenges,
    proposals,
    weekId,
    n: next.n,
    overrides: next.overrides,
    source: next.source,
  });
  // The proposals were validated when they were made, so this is a real fault.
  if (result.error) throw new Error(result.error);
  if (next.reapply) console.log(`♻️  Re-applying the recorded pick #${next.n}.`);
  await save(result, { n: next.n, weekId, fallbackPick: !next.reapply });
}

(fallback ? runFallback() : runPick()).catch((err) => {
  console.error('💥', err);
  process.exit(1);
});
