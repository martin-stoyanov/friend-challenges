/**
 * Telegram Bot API client and the message formats for weekly proposals.
 *
 * Messages use parse_mode HTML, so every piece of model- or user-written text
 * goes through escapeHtml. Each proposal ends with a plain-text tag line,
 * "#<n> · <weekId>", which survives in reply_to_message.text when you reply to
 * it. That is how a reply finds its proposal without the webhook keeping state
 * (plan D4).
 */

const API_BASE = 'https://api.telegram.org';

// Telegram rejects a message over 4096 characters. Measuring the HTML source
// rather than the rendered text overcounts, which errs on the safe side.
export const MAX_MESSAGE_LENGTH = 4096;

const REQUEST_TIMEOUT_MS = 15_000;

// How much of the description, once escaped, a confirmation echoes back, and
// how many style warnings it lists at what length. Together with the capped
// fields (scripts/lib/apply.mjs) they keep a confirmation under
// MAX_MESSAGE_LENGTH; formatConfirmation shortens the echo further if not.
const CONFIRMATION_ECHO_LIMIT = 1_500;
const MAX_WARNING_LINES = 5;
const WARNING_LINE_LIMIT = 150;

const CATEGORY_LABELS = {
  friend: '👫 friends',
  couple: '💕 couples',
  both: '🎉 everyone',
};

export function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function callOnce(method, body, token, fetchImpl, timeoutMs) {
  let response;
  try {
    response = await fetchImpl(`${API_BASE}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // fetch's own message is a bare "fetch failed"; the cause says why. Neither
    // includes the URL, so the token stays out of logs.
    const reason = err.name === 'TimeoutError'
      ? `no response in ${timeoutMs / 1000}s`
      : err.cause?.code ?? err.cause?.message ?? err.message;
    return { error: new Error(`Telegram ${method} request failed: ${reason}`), retryable: true };
  }
  const data = await response.json().catch(() => null);
  if (response.ok && data?.ok) return { result: data.result };
  return {
    error: new Error(`Telegram ${method} failed (${response.status}): ${data?.description ?? 'no response body'}`),
    retryable: response.status === 429 || response.status >= 500,
    // Telegram says how long to back off on a 429.
    retryAfterMs: (data?.parameters?.retry_after ?? 0) * 1000,
  };
}

/**
 * Calls one Bot API method and returns its `result`. Errors name the method and
 * Telegram's description, never the URL, which contains the token.
 *
 * Network errors, 429s and 5xx are retried `retries` times (default 2), waiting
 * as long as Telegram asks, up to 30s. The webhook passes retries: 0 and a
 * short timeoutMs because a Netlify function has seconds to answer.
 */
export async function telegramApi(method, body, {
  token = process.env.TELEGRAM_BOT_TOKEN,
  fetchImpl = fetch,
  sleepImpl = sleep,
  retries = 2,
  timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set');
  for (let attempt = 0; ; attempt++) {
    const outcome = await callOnce(method, body, token, fetchImpl, timeoutMs);
    if (!outcome.error) return outcome.result;
    const waitMs = outcome.retryAfterMs || 1_000 * 2 ** attempt;
    if (!outcome.retryable || attempt >= retries || waitMs > 30_000) throw outcome.error;
    await sleepImpl(waitMs);
  }
}

/** Sends `message` ({ text, reply_markup? }) as HTML with link previews off. */
export function sendMessage(chatId, message, options) {
  return telegramApi('sendMessage', {
    chat_id: chatId,
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...message,
  }, options);
}

export function proposalTag(n, weekId) {
  return `#${n} · ${weekId}`;
}

/**
 * The tag line that ends a clarifying question from the bot. Any reply to it
 * goes to Claude, so the answer is read together with the question
 * (docs/plans/telegram-freeform-replies.md, D15).
 */
export function questionTag(weekId) {
  return `? · ${weekId}`;
}

// How much of his message a question quotes back. Question plus quote plus tag
// stay under the 1500 characters the webhook forwards when he replies.
const QUOTED_MESSAGE_LIMIT = 1_000;
const QUOTE_INTRO = 'You wrote:';
// Marks a quote that had to be cut. A cut quote is still context for Claude,
// but never counts as his exact words (a description could end mid-word).
const QUOTE_CUT = '[…cut short]';

/**
 * A clarifying question (D15): the question, what he wrote, and the question
 * tag, so his reply is read with both. Plain text, escaped.
 */
export function formatQuestion({ question, message, weekId }) {
  const quote = clipGraphemes(message, QUOTED_MESSAGE_LIMIT);
  return {
    text: [
      // One line, so nothing the question says can pass for the quote below.
      `🤔 ${escapeHtml(question.replace(/\s*\n\s*/g, ' '))}`,
      '',
      QUOTE_INTRO,
      escapeHtml(quote),
      ...(quote.length < message.length ? [QUOTE_CUT] : []),
      questionTag(weekId),
    ].join('\n'),
  };
}

/**
 * What he wrote, read back out of a question's text (the inverse of
 * formatQuestion), or null when the text isn't one of the bot's questions or
 * the quote was cut short.
 */
export function quotedMessageFromQuestion(text) {
  const lines = (text ?? '').split('\n');
  if (lines[2] !== QUOTE_INTRO || !/^\? · \d{4}-w\d{2}$/.test(lines.at(-1) ?? '')) return null;
  const quote = lines.slice(3, -1);
  if (quote.at(-1) === QUOTE_CUT) return null;
  return quote.join('\n') || null;
}

/** "Mon 19 Oct" for a YYYY-MM-DD weekOf, read as a local date. */
export function formatWeekLabel(weekOf) {
  return new Date(`${weekOf}T00:00:00`).toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

/** One proposal as a message with its own "Pick" button. */
export function formatProposal(proposal, weekId) {
  const { n } = proposal;
  const meta = [
    CATEGORY_LABELS[proposal.category] ?? proposal.category,
    proposal.difficulty,
    proposal.players && `${proposal.players} players`,
    proposal.timeEstimate,
  ].filter(Boolean).join(' · ');
  const link = /^https?:\/\//i.test(proposal.exampleUrl ?? '')
    ? `▶ <a href="${escapeHtml(proposal.exampleUrl)}">Examples on TikTok</a>`
    : null;
  const why = proposal.reasoning ? `<i>Why now: ${escapeHtml(proposal.reasoning)}</i>` : null;
  const tag = proposalTag(n, weekId);

  const heading = [proposal.emoji, proposal.title].filter(Boolean).join(' ');
  const build = (description, reasoning) => [
    `<b>${escapeHtml(heading)}</b>`,
    escapeHtml(meta),
    '',
    escapeHtml(description),
    '',
    link,
    reasoning,
    tag,
  ].filter((line) => line !== null).join('\n');

  // Too long: drop the reasoning, then shorten the description. The tag line
  // and the markup always survive. The description is cut by grapheme, before
  // escaping, with each grapheme counted at its escaped length, so it never
  // splits an emoji or an entity like &amp; and never cuts more than it must.
  const description = proposal.description ?? '';
  let text = build(description, why);
  if (text.length > MAX_MESSAGE_LENGTH) text = build(description, null);
  if (text.length > MAX_MESSAGE_LENGTH) {
    const graphemes = Array.from(
      new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(description),
      (s) => s.segment
    );
    let excess = text.length - MAX_MESSAGE_LENGTH + 1; // room for the "…"
    while (excess > 0 && graphemes.length > 0) excess -= escapeHtml(graphemes.pop()).length;
    text = build(`${graphemes.join('').trimEnd()}…`, null);
  }

  return {
    text,
    reply_markup: {
      inline_keyboard: [[{ text: `✅ Pick #${n}`, callback_data: `pick:${weekId}:${n}` }]],
    },
  };
}

/**
 * The first message of a batch. A later batch for the same week says "more",
 * and a batch asked for with a theme names it.
 */
export function formatHeader(weekId, weekOf, count, { more = false, hint = null } = {}) {
  const noun = count === 1 ? 'idea' : 'ideas';
  const theme = hint ? ` around "${escapeHtml(hint)}"` : '';
  return {
    text: `🗓️ <b>${count} ${more ? 'more ' : ''}${noun}${theme} for the week of ${escapeHtml(formatWeekLabel(weekOf))}</b> (${escapeHtml(weekId)})`,
  };
}

/** How to answer. Sent after each batch and in reply to /help. */
export function replyGuideText() {
  return [
    '<b>How to answer</b>',
    '• Tap <b>Pick</b> under a proposal to use it as written.',
    '• Or reply to a proposal with your own text. That text becomes the description.',
    '• Or send <code>2</code> to pick #2 as written, or put your own description on the lines after the number.',
    '',
    'Change other fields with one line each:',
    '<code>title: The Mirror Challenge</code>',
    '<code>emoji: 🪞</code>',
    '<code>category: couple</code> (friend, couple or both)',
    '<code>difficulty: easy</code> (easy, medium or hard)',
    '<code>players: 2</code>',
    '<code>time: 10-15 min</code>',
    '<code>link: https://…</code>',
    '',
    'Your text is used exactly as written. Send another reply any time before Monday to change the pick; picking the same number again keeps your earlier changes.',
  ].join('\n');
}

/** The last message of a batch: the reply guide, the deadline and a "more" button. */
export function formatFooter(weekId, count) {
  return {
    text: [
      replyGuideText(),
      '',
      'No pick by Sunday noon (UTC) and #1 goes up on its own.',
    ].join('\n'),
    reply_markup: {
      inline_keyboard: [[{ text: `🔄 ${count} more`, callback_data: `more:${weekId}` }]],
    },
  };
}

/**
 * Sends a batch in order: the header, each proposal, then the footer.
 *
 * All or nothing: if any message fails, the ones already sent are deleted
 * (best effort) and the error is rethrown. A half-sent batch would leave live
 * Pick buttons for a batch that was never saved, and a rerun would renumber,
 * so an old "Pick #1" could publish a different challenge.
 */
export async function sendProposalBatch(chatId, { weekId, weekOf, proposals, more = false, moreCount, hint = null }, options) {
  const messages = [
    formatHeader(weekId, weekOf, proposals.length, { more, hint }),
    ...proposals.map((proposal) => formatProposal(proposal, weekId)),
    formatFooter(weekId, moreCount ?? proposals.length),
  ];
  const sentIds = [];
  try {
    for (const message of messages) {
      const sent = await sendMessage(chatId, message, options);
      sentIds.push(sent?.message_id);
    }
  } catch (err) {
    for (const messageId of sentIds.filter(Boolean)) {
      await telegramApi('deleteMessage', { chat_id: chatId, message_id: messageId }, { ...options, retries: 0 })
        .catch(() => {});
    }
    throw err;
  }
}

/** Cuts plain text to at most `max` characters by whole graphemes, so no emoji is split. */
export function clipGraphemes(value, max) {
  let out = '';
  for (const { segment } of new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(value)) {
    if (out.length + segment.length > max) break;
    out += segment;
  }
  return out;
}

/**
 * Escapes `raw` and cuts it to at most `limit` characters of escaped text, by
 * whole graphemes, adding `suffix` when it had to cut. Never splits an emoji or
 * an entity.
 */
function clipEscaped(raw, limit, suffix = '…') {
  const escaped = escapeHtml(raw);
  if (escaped.length <= limit) return escaped;
  let kept = '';
  for (const { segment } of new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(raw)) {
    const next = kept + escapeHtml(segment);
    if (next.length + suffix.length > limit) break;
    kept = next;
  }
  return `${kept.trimEnd()}${suffix}`;
}

/**
 * Confirmation of a pick, sent after the commit is pushed. It echoes what was
 * applied, so a misread reply shows up at once, and ends with the same tag line
 * as the proposal, so replying to it changes the same pick.
 *
 * `violations` are style-check results for the description. Martin's own text
 * is published as written (plan D5), so they are reported, not fixed.
 * `descriptionBy` is who wrote the description on the card (it sets how a
 * warning is worded); `wroteDescription` says Claude wrote it just now. Every
 * part that can grow is clipped, so the message always fits in one Telegram
 * message whatever passed validation.
 */
export function formatConfirmation({
  challenge, n, weekId, changed = [], violations = [], fallback = false, live = false,
  readAs = null, descriptionBy = null, wroteDescription = false,
}) {
  const week = escapeHtml(formatWeekLabel(challenge.weekOf));
  const heading = fallback
    ? `⏰ <b>No pick by Sunday, so #${n} is set for the week of ${week}</b>`
    : `✅ <b>#${n} is set for the week of ${week}</b>`;
  const meta = [
    CATEGORY_LABELS[challenge.category] ?? challenge.category,
    challenge.difficulty,
    `${challenge.players} players`,
    challenge.timeEstimate,
  ].map(escapeHtml).join(' · ');
  // Some rule messages quote a whole sentence back; show a few, each short.
  const warnings = [...new Set(violations.map((v) => v.message))]
    .slice(0, MAX_WARNING_LINES)
    .map((message) => `• ${clipEscaped(message, WARNING_LINE_LIMIT)}`);

  const build = (echoLimit) => {
    const lines = [
      heading,
      `<b>${escapeHtml(`${challenge.emoji} ${challenge.title}`)}</b>`,
      meta,
      '',
      // The echo is for reading back; the card itself keeps every word.
      clipEscaped(challenge.description, echoLimit, '… (shortened here; the card has all of it)'),
      '',
    ];
    if (readAs) lines.push(`I read this as: ${escapeHtml(clipGraphemes(readAs, 200))}`);
    if (changed.length) lines.push(`Your changes: ${escapeHtml(changed.join(', '))}`);
    if (wroteDescription) lines.push('I wrote the description, as you asked.');
    if (warnings.length) {
      lines.push(
        descriptionBy === 'claude'
          ? '⚠️ The style check still flags the description I wrote. Reply with what to change, or with your own version.'
          : '⚠️ The style check flagged the description. It is published as written; reply with a new version to replace it.',
        ...warnings
      );
    }
    lines.push(
      live
        ? 'This week is already live, so the site changes as soon as it redeploys.'
        : `It goes live on ${week}. Reply to this message to change it before then.`,
      proposalTag(n, weekId)
    );
    return lines.join('\n');
  };

  let text = build(CONFIRMATION_ECHO_LIMIT);
  if (text.length > MAX_MESSAGE_LENGTH) {
    text = build(Math.max(200, CONFIRMATION_ECHO_LIMIT - (text.length - MAX_MESSAGE_LENGTH) - 50));
  }
  return { text };
}

/** A one-off notice: an error answer, an acknowledgement. Plain text, escaped. */
export function formatNotice(text) {
  return { text: escapeHtml(text) };
}
