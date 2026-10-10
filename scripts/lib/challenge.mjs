/**
 * Validation and bookkeeping for challenge records in src/data/challenges.json.
 */

export const REQUIRED_FIELDS = [
  'title', 'description', 'category', 'difficulty', 'emoji',
  'trendSource', 'players', 'timeEstimate', 'exampleUrl',
];

/**
 * Problems with a model-written challenge, as messages. Empty means it can be
 * used. Non-http(s) URLs are rejected so nothing like a javascript:/data: URL
 * lands in challenges.json and later gets rendered as an href on the site.
 */
export function validateChallenge(result) {
  if (!result || typeof result !== 'object') return ['is not a JSON object'];
  const problems = REQUIRED_FIELDS
    .filter((field) => !result[field])
    .map((field) => `missing required field: ${field}`);
  if (result.exampleUrl && !/^https?:\/\//i.test(result.exampleUrl)) {
    problems.push(`exampleUrl is not an http(s) URL: ${result.exampleUrl}`);
  }
  return problems;
}

// TikTok /tag/ pages require the exact hashtag to be registered with videos, so a
// model-invented slug dead-ends on "Couldn't find this hashtag". A /search?q= URL
// matches videos by content and never hits that empty state, so we normalize every
// exampleUrl to a search URL. Real search URLs pass through untouched; anything else
// (including /tag/<slug>) becomes a search for the challenge title, which has proper
// word boundaries a concatenated hashtag slug like "squeezeballchallenge" lacks.
export function toTikTokSearchUrl(url, title) {
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

const normalizeTitle = (title) => title.toLowerCase().replace(/[^a-z]/g, '');

/** Fuzzy title match: identical once normalized, or one contains the other. */
export function isDuplicateTitle(title, existingTitles) {
  const normalizedNew = normalizeTitle(title);
  return existingTitles.some((t) => {
    const normalizedExisting = normalizeTitle(t);
    return normalizedNew === normalizedExisting ||
           normalizedNew.includes(normalizedExisting) ||
           normalizedExisting.includes(normalizedNew);
  });
}

/** The fields challenges.json stores, in its key order. Drops extras like `reasoning`. */
export function buildChallengeRecord(result, weekId, weekOf) {
  return {
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
}

export function sortByWeekDesc(challenges) {
  return [...challenges].sort(
    (a, b) => new Date(b.weekOf).getTime() - new Date(a.weekOf).getTime()
  );
}

/**
 * Returns a new list with `challenge` in it, newest week first. An entry with
 * the same id is replaced, so re-applying a week's pick never duplicates it.
 */
export function upsertChallenge(challenges, challenge) {
  return sortByWeekDesc([
    challenge,
    ...challenges.filter((c) => c.id !== challenge.id),
  ]);
}
