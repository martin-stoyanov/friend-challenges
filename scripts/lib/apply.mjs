/**
 * Applying a pick: the pure part of scripts/apply-choice.mjs.
 *
 * Martin's overrides are used exactly as given (plan D5). The only exception
 * is the link: his is kept as given if it is http(s), and a generated one goes
 * through toTikTokSearchUrl. Applying is an upsert keyed by week id (D6), so a
 * later reply for the same week replaces the pick.
 */

import {
  buildChallengeRecord,
  CATEGORIES,
  DIFFICULTIES,
  toTikTokSearchUrl,
  upsertChallenge,
  validateChallenge,
} from './challenge.mjs';
import { getCurrentMonday } from './dates.mjs';
import { findProposal, markPicked } from './proposals.mjs';

export const OVERRIDE_FIELDS = [
  'title', 'description', 'emoji', 'category', 'difficulty', 'players', 'timeEstimate', 'exampleUrl',
];

const FIELD_LABELS = {
  title: 'title',
  description: 'description',
  emoji: 'emoji',
  category: 'category',
  difficulty: 'difficulty',
  players: 'players',
  timeEstimate: 'time',
  exampleUrl: 'link',
};

// Generous for a card, and small enough that a confirmation echoing them all
// stays under Telegram's 4096-character limit.
const MAX_LENGTHS = {
  title: 100,
  description: 2000,
  emoji: 16,
  players: 20,
  timeEstimate: 30,
  exampleUrl: 500,
};

const WEEK_ID = /^\d{4}-w\d{2}$/;

// Where a pick came from. Stored in the proposals file and shown nowhere else.
export const PICK_SOURCES = ['button', 'reply', 'number', 'message', 'manual', 'fallback'];

// A payload value quoted back in an error, cut short so a junk value can't
// flood the chat.
const quote = (value) => {
  const text = String(value);
  return JSON.stringify(text.length > 40 ? `${text.slice(0, 40)}…` : text);
};

/**
 * Problems with an overrides object from a dispatch payload. The webhook's
 * parser already checked these, but the payload crosses a network boundary,
 * so it is checked again before anything is written.
 */
export function validateOverrides(overrides) {
  if (overrides === undefined || overrides === null) return [];
  if (typeof overrides !== 'object' || Array.isArray(overrides)) return ['overrides must be an object'];
  const problems = [];
  for (const [field, value] of Object.entries(overrides)) {
    if (!OVERRIDE_FIELDS.includes(field)) {
      problems.push(`unknown field: ${quote(field)}`);
    } else if (typeof value !== 'string' || !value.trim()) {
      problems.push(`${FIELD_LABELS[field]} must be non-empty text`);
    } else if (MAX_LENGTHS[field] && value.length > MAX_LENGTHS[field]) {
      problems.push(`${FIELD_LABELS[field]} is over ${MAX_LENGTHS[field]} characters`);
    } else if (field === 'category' && !CATEGORIES.includes(value)) {
      problems.push(`category must be one of ${CATEGORIES.join(', ')}`);
    } else if (field === 'difficulty' && !DIFFICULTIES.includes(value)) {
      problems.push(`difficulty must be one of ${DIFFICULTIES.join(', ')}`);
    } else if (field === 'exampleUrl' && !/^https?:\/\/\S+$/i.test(value)) {
      problems.push('link must be a single http(s) URL');
    }
  }
  return problems;
}

/** Human names of the fields Martin changed, in a stable order. */
export function changedFields(overrides = {}) {
  return OVERRIDE_FIELDS.filter((field) => field in overrides).map((field) => FIELD_LABELS[field]);
}

/** Sources that mean the pick came from Martin's Telegram chat. */
export const TELEGRAM_SOURCES = ['button', 'reply', 'number', 'message'];

const MAX_MESSAGE_LENGTH = 4096; // Telegram's own limit
const MAX_REPLY_TEXT_LENGTH = 1500; // what the webhook forwards

/**
 * A free-form message for Claude from a workflow_dispatch's inputs
 * (docs/plans/telegram-freeform-replies.md, Step 13), or { error }:
 *   week_id, message, reply_n (a number or empty), reply_text (or empty).
 * The message is kept exactly as sent.
 */
export function parseMessageEvent(inputs = {}) {
  const { week_id: weekId, message, reply_n: replyN = '', reply_text: replyText = '' } = inputs;
  if (typeof weekId !== 'string' || !WEEK_ID.test(weekId)) return { error: `${quote(weekId)} is not a week id like 2026-w43.` };
  if (typeof message !== 'string' || !message.trim()) return { error: 'There is no message to read.' };
  if (message.length > MAX_MESSAGE_LENGTH) return { error: 'That message is too long to read.' };
  if (replyN !== '' && !/^\d{1,3}$/.test(String(replyN))) return { error: `${quote(replyN)} is not a proposal number.` };
  if (typeof replyText !== 'string' || replyText.length > MAX_REPLY_TEXT_LENGTH * 2) {
    return { error: 'The replied-to text is not usable.' };
  }
  return { weekId, message, replyN: replyN === '' ? null : Number(replyN), replyText: replyText || null };
}

/**
 * The pick request from a workflow_dispatch event's inputs, or { error }.
 * The webhook and a hand-run of the workflow both arrive this way (plan D8):
 *   week_id    "2026-w43"
 *   pick       "2"
 *   overrides  optional JSON object of field overrides (the webhook sends this)
 *   description optional text, a shortcut for hand-runs from the Actions tab
 *   source     optional; "manual" when absent
 * Every value is a string, as workflow_dispatch inputs are.
 */
export function parsePickEvent(eventName, event) {
  if (eventName !== 'workflow_dispatch') {
    return { error: `Don't know how to read a pick from a ${eventName} event.` };
  }
  const inputs = event?.inputs ?? {};
  const weekId = inputs.week_id;
  const n = /^\d+$/.test(String(inputs.pick ?? '')) ? Number(inputs.pick) : NaN;
  const source = typeof inputs.source === 'string' && inputs.source.trim() ? inputs.source.trim() : 'manual';

  let overrides = {};
  if (typeof inputs.overrides === 'string' && inputs.overrides.trim()) {
    try {
      overrides = JSON.parse(inputs.overrides);
    } catch {
      return { error: 'The overrides are not valid JSON.' };
    }
  }
  if (typeof inputs.description === 'string' && inputs.description.trim()) {
    overrides = { ...overrides, description: inputs.description.trim() };
  }

  if (typeof weekId !== 'string' || !WEEK_ID.test(weekId)) return { error: `${quote(weekId)} is not a week id like 2026-w43.` };
  if (!Number.isInteger(n) || n < 1) return { error: `${quote(inputs.pick)} is not a proposal number.` };
  if (!PICK_SOURCES.includes(source)) return { error: `${quote(source)} is not a pick source.` };
  const problems = validateOverrides(overrides);
  if (problems.length) return { error: `${problems.join('; ')}.` };
  return { weekId, n, overrides: overrides ?? {}, source };
}

/**
 * Applies pick #n of a week. Returns either { error } with a sentence for
 * Martin, or { challenges, proposals, challenge, proposal, overrides } with the
 * updated challenges list and proposals file, and the overrides applied.
 *
 * Picking the same number again keeps the earlier overrides and adds the new
 * ones on top, so replying to a confirmation with a new description doesn't
 * undo a title changed before. A different number starts fresh.
 *
 * `descriptionBy` says who wrote a description in `overrides`: 'martin' (the
 * default; his text, used as written) or 'claude' (written on his request).
 * It is recorded with the pick, and only Martin's own text is exempt from
 * failing npm run lint:copy (docs/plans/telegram-freeform-replies.md, D14).
 *
 * Only the live week and later can change. Old Pick buttons stay in the chat
 * forever, and an archived card should not change because one got tapped.
 */
export function applyPick({ challenges, proposals, weekId, n, overrides: given = {}, source, descriptionBy, now = new Date() }) {
  if (!proposals) return { error: `Nothing was proposed for ${weekId}, so there is no #${n} to pick.` };
  if (proposals.weekOf < getCurrentMonday(now)) {
    return { error: `${weekId} is in the archive now. Picks can only change this week's challenge or a later one.` };
  }
  const proposal = findProposal(proposals, n);
  if (!proposal) {
    const numbers = proposals.proposals.map((p) => p.n);
    const range = numbers.length ? `#${Math.min(...numbers)}–#${Math.max(...numbers)}` : 'none';
    return { error: `There's no #${n} for ${weekId}. The proposals are ${range}.` };
  }
  const problems = validateOverrides(given);
  if (problems.length) return { error: `${problems.join('; ')}.` };

  const samePick = proposals.pick?.n === n;
  const earlier = samePick ? proposals.pick.overrides ?? {} : {};
  const overrides = { ...earlier, ...given };
  // Who wrote the description now on the card: whoever just changed it, or
  // whoever wrote the one carried over from the earlier pick.
  const author = 'description' in given
    ? descriptionBy ?? 'martin'
    : samePick ? proposals.pick.descriptionBy : undefined;
  const merged = { ...proposal, ...overrides };
  merged.exampleUrl = overrides.exampleUrl ?? toTikTokSearchUrl(proposal.exampleUrl, merged.title);
  const challenge = buildChallengeRecord(merged, weekId, proposals.weekOf);
  const invalid = validateChallenge(challenge);
  if (invalid.length) return { error: `#${n} can't be used as it is: ${invalid.join('; ')}.` };

  return {
    challenge,
    proposal,
    overrides,
    challenges: upsertChallenge(challenges, challenge),
    proposals: markPicked(proposals, {
      n,
      source,
      overrides,
      ...(overrides.description !== undefined && author && { descriptionBy: author }),
    }, now),
  };
}

/**
 * What Sunday's fallback should do for the coming week:
 *  - { action: 'none' } when the week already has a challenge;
 *  - { action: 'pick', n, overrides, source, reapply } to apply the recorded
 *    pick again (reapply: true), or #1;
 *  - { action: 'generate' } when nothing was ever proposed.
 */
export function fallbackAction({ weekId, challenges, proposals }) {
  if (challenges.some((c) => c.id === weekId)) return { action: 'none' };
  if (!proposals?.proposals.length) return { action: 'generate' };
  // A recorded pick missing from challenges.json is re-applied as it was, with
  // its own source, not replaced by #1.
  if (proposals.pick && findProposal(proposals, proposals.pick.n)) {
    return {
      action: 'pick',
      n: proposals.pick.n,
      overrides: proposals.pick.overrides ?? {},
      source: proposals.pick.source,
      reapply: true,
    };
  }
  const first = Math.min(...proposals.proposals.map((p) => p.n));
  return { action: 'pick', n: first, overrides: {}, source: 'fallback', reapply: false };
}
