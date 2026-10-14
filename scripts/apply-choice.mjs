#!/usr/bin/env node

/**
 * Applies a pick, or Sunday's fallback, to src/data/challenges.json and records
 * it in proposals/<weekId>.json. Normally run by
 * .github/workflows/apply-challenge.yml.
 *
 * Usage:
 *   node scripts/apply-choice.mjs
 *       Reads the pick from $GITHUB_EVENT_PATH: a workflow_dispatch started by
 *       the Telegram webhook or by hand from the Actions tab.
 *   node scripts/apply-choice.mjs --pick 2 [--week-id 2026-w43] [--description "…"]
 *       [--title "…"] [--emoji "…"] [--category …] [--difficulty …]
 *       [--players "…"] [--time "…"] [--link "…"]
 *       Applies a pick from the command line. The week defaults to the coming one.
 *   node scripts/apply-choice.mjs --message "the kitchen one, for friends" [--week-id 2026-w43]
 *       [--reply-n 2] [--reply-text "…"]
 *       Has Claude read a free-form message, as the workflow does when the
 *       event carries `message` (docs/plans/telegram-freeform-replies.md).
 *   node scripts/apply-choice.mjs --fallback
 *       Sunday: if the coming week has no challenge, applies the recorded pick
 *       or #1. With nothing proposed, writes generate=true to $GITHUB_OUTPUT so
 *       the workflow runs the generator instead.
 *
 *   --message-out <file>  Write the confirmation to <file> instead of sending
 *                         it, so the workflow sends it only after the commit
 *                         is pushed.
 *   --interpretation-cache <file>
 *                         Keep Claude's reading of a message in <file> and
 *                         reuse it, so applying again after a lost push race
 *                         neither pays twice nor reads the message differently.
 *
 * Exit codes: 0 when the pick was applied, or when a pick or message sent from
 * Telegram was answered in the chat: a wrong pick, a question back, help,
 * "more", or a message Claude couldn't read just now (an answer, not a
 * failure; the last also leaves an error annotation on the run). 1 for
 * everything else, including a bad pick or message given on the command line.
 *
 * $GITHUB_OUTPUT gets applied=true when challenges.json changed (the workflow
 * then commits and sends the confirmation) and generate=true when the
 * fallback found nothing proposed.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { checkDescription, formatViolations, loadStyleGuide } from './copy-style.mjs';
import {
  applyPick,
  changedFields,
  fallbackAction,
  parseMessageEvent,
  parsePickEvent,
  TELEGRAM_SOURCES,
} from './lib/apply.mjs';
import { callClaude } from './lib/claude.mjs';
import { formatDateLocal, getCurrentMonday, getNextMonday, getWeekId } from './lib/dates.mjs';
import { buildInterpretRequest, readInterpretation } from './lib/interpret.mjs';
import { readProposals, writeProposals } from './lib/proposals.mjs';
import {
  formatConfirmation,
  formatNotice,
  formatQuestion,
  quotedMessageFromQuestion,
  replyGuideText,
  sendMessage,
} from './lib/telegram.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CHALLENGES_PATH = path.join(__dirname, '..', 'src', 'data', 'challenges.json');

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const fallback = args.includes('--fallback');
const messageOut = flag('--message-out');
const interpretationCache = flag('--interpretation-cache');

// Claude Opus 5.5 reads free-form messages (plan D16): thinking on at medium
// effort, a strict JSON schema, server-side refusal fallbacks, no web search.
const INTERPRET_OPTIONS = {
  model: 'claude-opus-5-5',
  maxSearches: 0,
  maxTokens: 16000,
  effort: 'medium',
  fallbacks: 'default',
};

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

/**
 * The pick request, from flags or from the GitHub event. Either way it goes
 * through the same parsing and validation as a workflow_dispatch's inputs.
 */
function readRequest() {
  const upcoming = getWeekId(getNextMonday());
  let inputs;
  if (args.includes('--pick')) {
    const overrides = {};
    for (const [name, field] of Object.entries(CLI_OVERRIDES)) {
      const value = flag(name);
      if (value !== undefined) overrides[field] = value;
    }
    inputs = { week_id: flag('--week-id'), pick: flag('--pick'), overrides: JSON.stringify(overrides) };
  } else {
    const eventPath = process.env.GITHUB_EVENT_PATH;
    if (!eventPath || process.env.GITHUB_EVENT_NAME !== 'workflow_dispatch') {
      return { error: 'No pick given. Use --pick N, --fallback, or run from a workflow_dispatch.' };
    }
    inputs = JSON.parse(fs.readFileSync(eventPath, 'utf-8')).inputs ?? {};
  }
  // A hand-run from the Actions tab may leave the week empty: the coming one.
  const withWeek = { ...inputs, week_id: inputs.week_id || upcoming };
  return parsePickEvent('workflow_dispatch', { inputs: withWeek });
}

/** Writes the applied pick and delivers its confirmation. */
async function save(result, { n, weekId, fallbackPick = false, readAs = null, wroteDescription = false }) {
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
    readAs,
    // Who wrote the description on the card, which sets how a warning reads.
    descriptionBy: result.proposals.pick.descriptionBy ?? null,
    wroteDescription,
  }));
}

// When the request itself is invalid there is no parsed source; the raw input
// still says whether Martin is waiting in the chat for an answer.
function readSourceHint() {
  if (args.includes('--pick') || !process.env.GITHUB_EVENT_PATH) return 'manual';
  try {
    return JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf-8')).inputs?.source;
  } catch {
    return undefined;
  }
}

async function runPick() {
  const request = readRequest();
  const fromTelegram = TELEGRAM_SOURCES.includes(request.source ?? readSourceHint());
  const answer = async (problem) => {
    console.error(`❌ ${problem}`);
    if (fromTelegram) {
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
    // A re-applied pick keeps whoever wrote its description.
    descriptionBy: next.reapply ? proposals.pick.descriptionBy : undefined,
  });
  // The proposals were validated when they were made, so this is a real fault.
  if (result.error) throw new Error(result.error);
  if (next.reapply) console.log(`♻️  Re-applying the recorded pick #${next.n}.`);
  await save(result, { n: next.n, weekId, fallbackPick: !next.reapply });
}

/** A free-form message from the event or flags, or null when there is none. */
function readMessageRequest() {
  let inputs;
  if (args.includes('--message')) {
    inputs = {
      week_id: flag('--week-id') || getWeekId(getNextMonday()),
      message: flag('--message'),
      reply_n: flag('--reply-n') ?? '',
      reply_text: flag('--reply-text') ?? '',
    };
  } else if (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch' && process.env.GITHUB_EVENT_PATH) {
    inputs = JSON.parse(fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf-8')).inputs ?? {};
    if (!inputs.message) return null;
  } else {
    return null;
  }
  // A hand-run from the Actions tab may leave the week empty: the coming one.
  return parseMessageEvent({ ...inputs, week_id: inputs.week_id || getWeekId(getNextMonday()) });
}

const MAX_DESCRIPTION_LENGTH = 2000; // as validateOverrides allows

/**
 * A description Claude wrote on request is copy like any other: if it breaks
 * writing-style.md, ask once for a rewrite and keep whichever breaks fewer
 * rules (plan D14).
 */
async function polishClaudeDescription(reading, { message }) {
  const description = reading.overrides.description;
  const violations = checkDescription(description);
  const fits = (text) => text.length <= MAX_DESCRIPTION_LENGTH;
  if (!violations.length && fits(description)) return reading;

  const schema = {
    type: 'object',
    properties: { description: { type: 'string' } },
    required: ['description'],
    additionalProperties: false,
  };
  const system = `You fix a challenge card's description so it follows the style guide, while still doing what Martin asked. Keep the challenge's mechanics; never add a prop, number or rule that isn't part of it. Stay under ${MAX_DESCRIPTION_LENGTH} characters.\n\n<style-guide>\n${loadStyleGuide() ?? ''}\n</style-guide>`;
  const prompt = [
    `Martin asked: ${message}`,
    '',
    `Description you wrote:\n${description}`,
    '',
    violations.length ? `It broke these rules:\n${formatViolations(violations)}` : `It is over ${MAX_DESCRIPTION_LENGTH} characters.`,
    '',
    'Rewrite it so it passes and still does what he asked (if he asked for shorter, keep it shorter).',
  ].join('\n');
  let rewrite = '';
  try {
    const answer = await callClaude(prompt, system, { ...INTERPRET_OPTIONS, schema });
    rewrite = typeof answer?.description === 'string' ? answer.description.trim() : '';
  } catch (err) {
    console.warn(`Rewrite failed (${err.message.split('\n')[0]}); keeping the first draft.`);
  }
  // Keep whichever fits and breaks fewer rules; never a longer-than-allowed one.
  const candidates = [description, rewrite].filter((text) => text && fits(text));
  if (!candidates.length) {
    return { type: 'clarify', question: 'The description I wrote came out too long. Could you say what to keep?' };
  }
  const best = candidates.reduce((a, b) => (checkDescription(b).length < checkDescription(a).length ? b : a));
  return best === description ? reading : { ...reading, overrides: { ...reading.overrides, description: best } };
}

/** Claude's reading of the message, made once per run (see --interpretation-cache). */
async function interpretOnce(context) {
  if (interpretationCache && fs.existsSync(interpretationCache)) {
    return JSON.parse(fs.readFileSync(interpretationCache, 'utf-8'));
  }
  const request = buildInterpretRequest({ ...context, styleGuide: loadStyleGuide() ?? '' });
  const answer = await callClaude(request.prompt, request.system, { ...INTERPRET_OPTIONS, schema: request.schema });
  let reading = readInterpretation(answer, context);
  if (reading.type === 'pick' && reading.descriptionBy === 'claude') reading = await polishClaudeDescription(reading, context);
  console.log(`🧠 Read as: ${JSON.stringify(reading)}`);
  if (interpretationCache) fs.writeFileSync(interpretationCache, JSON.stringify(reading));
  return reading;
}

/** Starts propose-challenges.yml for another batch, with the workflow's own token (plan D17). */
async function askForMore(weekId, hint) {
  const { GITHUB_TOKEN, GITHUB_REPOSITORY, GITHUB_REF_NAME } = process.env;
  if (!GITHUB_TOKEN || !GITHUB_REPOSITORY) throw new Error('GITHUB_TOKEN and GITHUB_REPOSITORY are needed to ask for more ideas');
  const response = await fetch(
    `https://api.github.com/repos/${GITHUB_REPOSITORY}/actions/workflows/propose-challenges.yml/dispatches`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        'Content-Type': 'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        ref: GITHUB_REF_NAME || 'master',
        inputs: { mode: 'more', week_id: weekId, ...(hint && { hint }) },
      }),
    }
  );
  if (response.status !== 204 && response.status !== 200) {
    throw new Error(`GitHub answered ${response.status} when asked for more ideas`);
  }
}

async function runMessage(request) {
  // From Telegram every outcome is an answer in the chat (exit 0). Typed on the
  // command line, a refusal is a failure (exit 1), as for --pick.
  const fromCli = args.includes('--message');
  const answer = async (text) => {
    console.error(`❌ ${text}`);
    await tell(formatNotice(`⚠️ ${text}`));
    if (fromCli) process.exitCode = 1;
  };

  if (request.error) return answer(`${request.error} Send /help for the reply format.`);
  const { weekId, message, replyN, replyText } = request;
  const proposals = readProposals(weekId);
  if (!proposals) {
    return answer(`Nothing has been proposed for ${weekId} yet, so there's nothing to pick from. New ideas arrive on Thursdays.`);
  }
  const challenges = readChallenges();
  const published = challenges.find((c) => c.id === weekId) ?? null;
  const earlierMessage = quotedMessageFromQuestion(replyText);
  let reading;
  try {
    reading = await interpretOnce({ message, replyN, replyText, proposals, published, earlierMessage });
  } catch (err) {
    // An API error or a refusal: tell him plainly, and flag the run.
    console.log(`::error::Claude could not read the message: ${err.message.split('\n')[0]}`);
    return answer("I couldn't read that message just now. Try again in a minute, or use the exact format (send /help).");
  }

  switch (reading.type) {
    case 'help':
      await tell({ text: replyGuideText() });
      return;
    case 'clarify':
      // Quote what he wrote, including what he wrote before, so nothing is lost.
      await tell(formatQuestion({
        question: reading.question,
        message: earlierMessage ? `${earlierMessage}\n${message}` : message,
        weekId,
      }));
      return;
    case 'more':
      if (proposals.weekOf < getCurrentMonday()) {
        return answer(`${weekId} is in the archive now, so it can't get more ideas.`);
      }
      try {
        await askForMore(weekId, reading.hint);
      } catch (err) {
        console.log(`::error::${err.message}`);
        return answer("I couldn't start a new batch just now. Try the 🔄 more button, or ask again in a minute.");
      }
      await tell(formatNotice(`🔄 Finding more ideas${reading.hint ? ` around "${reading.hint}"` : ''}. They arrive in a minute or two.`));
      return;
    case 'pick': {
      const result = applyPick({
        challenges,
        proposals,
        weekId,
        n: reading.n,
        overrides: reading.overrides,
        source: 'message',
        descriptionBy: reading.descriptionBy === 'none' ? undefined : reading.descriptionBy,
      });
      if (result.error) return answer(result.error);
      await save(result, {
        n: reading.n,
        weekId,
        readAs: reading.readAs,
        wroteDescription: reading.descriptionBy === 'claude',
      });
      return;
    }
    default:
      throw new Error(`Unexpected reading: ${JSON.stringify(reading)}`);
  }
}

const messageRequest = fallback ? null : readMessageRequest();
(fallback ? runFallback() : messageRequest ? runMessage(messageRequest) : runPick()).catch((err) => {
  console.error('💥', err);
  process.exit(1);
});
