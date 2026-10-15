/**
 * The proposals file for one week: proposals/<weekId>.json.
 *
 * It holds every proposal generated for that week, numbered continuously
 * across batches (#1–#4, then #5–#8 after "more"), and the pick once one is
 * made (plan D3). The file is committed, so it doubles as a record of what
 * was offered and what was chosen. It never holds the chat id or any token.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  isDuplicateTitle,
  normalizeEnums,
  normalizeTitle,
  toTikTokSearchUrl,
  validateChallenge,
} from './challenge.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROPOSALS_DIR = path.join(__dirname, '..', '..', 'proposals');

// The longest theme a "more" request can carry (plan D17), shared by the
// interpreter that produces it and the generator that uses it.
export const MAX_HINT_LENGTH = 200;

// The fields a proposal carries: the challenge record minus id/weekOf, plus
// the model's reasoning. Anything else the model returns is dropped.
const PROPOSAL_FIELDS = [
  'title', 'description', 'category', 'difficulty', 'emoji',
  'trendSource', 'players', 'timeEstimate', 'exampleUrl', 'reasoning',
];

export function proposalsPath(weekId, dir = PROPOSALS_DIR) {
  if (!/^\d{4}-w\d{2}$/.test(weekId)) throw new Error(`Not a week id: ${weekId}`);
  return path.join(dir, `${weekId}.json`);
}

/** The week's file, or null if nothing has been proposed for it yet. */
export function readProposals(weekId, dir = PROPOSALS_DIR) {
  const file = proposalsPath(weekId, dir);
  if (!fs.existsSync(file)) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    throw new Error(`${path.basename(file)} is not valid JSON: ${err.message}`);
  }
  // The filename is the source of truth; a file claiming another week would
  // record a pick under the wrong id.
  if (parsed?.weekId !== weekId) {
    throw new Error(`${path.basename(file)} says it is for ${parsed?.weekId}, not ${weekId}`);
  }
  return parsed;
}

export function writeProposals(proposals, dir = PROPOSALS_DIR) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(proposalsPath(proposals.weekId, dir), JSON.stringify(proposals, null, 2) + '\n');
}

export function createProposals(weekId, weekOf) {
  return { weekId, weekOf, proposals: [], pick: null };
}

/**
 * Adds a batch. Returns { file, added }: a new file object (the input is not
 * changed) and the added proposals with their numbers and batch.
 */
export function appendBatch(file, drafts, now = new Date()) {
  const lastN = Math.max(0, ...file.proposals.map((p) => p.n));
  const batch = Math.max(0, ...file.proposals.map((p) => p.batch)) + 1;
  const createdAt = now.toISOString();
  const added = drafts.map((draft, i) => ({
    n: lastN + i + 1,
    batch,
    createdAt,
    ...Object.fromEntries(PROPOSAL_FIELDS.filter((f) => draft[f] !== undefined).map((f) => [f, draft[f]])),
  }));
  return { file: { ...file, proposals: [...file.proposals, ...added] }, added };
}

/** Titles already offered for this week, so a new batch can avoid them. */
export function proposedTitles(file) {
  return file ? file.proposals.map((p) => p.title) : [];
}

export function findProposal(file, n) {
  return file?.proposals.find((p) => p.n === n) ?? null;
}

/** Records the pick. Returns a new file object. */
export function markPicked(file, pick, now = new Date()) {
  return { ...file, pick: { ...pick, at: now.toISOString() } };
}

/**
 * Picks the usable drafts from a model reply, keeping the model's ranking:
 * drops invalid ones and repeats (of avoidTitles or of each other), normalizes
 * links, and stops at `count`. Returns { kept, dropped: [{ title, reason }] }.
 */
export function selectProposals(drafts, { avoidTitles = [], count }) {
  const kept = [];
  const dropped = [];
  for (const raw of Array.isArray(drafts) ? drafts : []) {
    if (kept.length >= count) break;
    const draft = normalizeEnums(raw);
    const problems = validateChallenge(draft);
    if (problems.length) {
      dropped.push({ title: draft?.title ?? '(untitled)', reason: problems.join('; ') });
      continue;
    }
    if (isDuplicateTitle(draft.title, [...avoidTitles, ...kept.map((k) => k.title)])) {
      dropped.push({ title: draft.title, reason: 'too close to one already used or proposed' });
      continue;
    }
    kept.push({ ...draft, exampleUrl: toTikTokSearchUrl(draft.exampleUrl, draft.title) });
  }
  return { kept, dropped };
}

/**
 * Applies style rewrites to proposals. Rewrites are matched by title, never by
 * position, so a reordered or short reply can't swap descriptions between
 * challenges. A rewrite is kept only if it breaks fewer rules than the draft.
 * `check` is checkDescription. Returns { proposals, stillFailing }.
 */
export function mergeRewrites(proposals, rewrites, check) {
  const byTitle = new Map(
    (Array.isArray(rewrites) ? rewrites : [])
      .filter((r) => typeof r?.title === 'string' && typeof r?.description === 'string')
      .map((r) => [normalizeTitle(r.title), r.description])
  );
  const stillFailing = [];
  const merged = proposals.map((proposal) => {
    const before = check(proposal.description);
    if (before.length === 0) return proposal;
    const rewrite = byTitle.get(normalizeTitle(proposal.title));
    const after = rewrite === undefined ? before : check(rewrite);
    const better = after.length < before.length;
    const violations = better ? after : before;
    if (violations.length) stillFailing.push({ title: proposal.title, violations });
    return better ? { ...proposal, description: rewrite } : proposal;
  });
  return { proposals: merged, stillFailing };
}

/**
 * Puts an already-sent batch back into the week's file. Used when a propose
 * run's push lost a race: the workflow resets to the new master and restores
 * the exact proposals (with the numbers Martin already has on his phone)
 * instead of generating again. A number taken by a different proposal is an
 * error, since the buttons in the chat would then point at the wrong one.
 */
export function restoreBatch(file, added) {
  const byNumber = new Map(file.proposals.map((p) => [p.n, p]));
  for (const proposal of added) {
    const there = byNumber.get(proposal.n);
    if (there && there.title !== proposal.title) {
      throw new Error(`#${proposal.n} for ${file.weekId} is already "${there.title}", not "${proposal.title}"`);
    }
  }
  const missing = added.filter((p) => !byNumber.has(p.n));
  return { ...file, proposals: [...file.proposals, ...missing].sort((a, b) => a.n - b.n) };
}

/**
 * True when the week's newest batch went out less than `windowMs` ago. Two taps
 * on "more" queue two runs; the second starts seconds after the first pushes,
 * sees its fresh batch and stands down instead of sending another.
 */
export function hasFreshBatch(file, now = new Date(), windowMs = 90_000) {
  const newest = Math.max(0, ...(file?.proposals ?? []).map((p) => Date.parse(p.createdAt) || 0));
  return newest > 0 && now.getTime() - newest < windowMs;
}
