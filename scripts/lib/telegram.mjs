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

/**
 * Calls one Bot API method and returns its `result`. Errors name the method and
 * Telegram's description, never the URL, which contains the token.
 */
export async function telegramApi(method, body, {
  token = process.env.TELEGRAM_BOT_TOKEN,
  fetchImpl = fetch,
} = {}) {
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set');
  let response;
  try {
    response = await fetchImpl(`${API_BASE}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    // fetch's own message is a bare "fetch failed"; the cause says why. Neither
    // includes the URL, so the token stays out of logs.
    const reason = err.name === 'TimeoutError'
      ? `no response in ${REQUEST_TIMEOUT_MS / 1000}s`
      : err.cause?.code ?? err.cause?.message ?? err.message;
    throw new Error(`Telegram ${method} request failed: ${reason}`);
  }
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) {
    throw new Error(`Telegram ${method} failed (${response.status}): ${data?.description ?? 'no response body'}`);
  }
  return data.result;
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

/** The first message of a batch. */
export function formatHeader(weekId, weekOf, count) {
  return {
    text: `🗓️ <b>${count} ${count === 1 ? 'idea' : 'ideas'} for the week of ${escapeHtml(formatWeekLabel(weekOf))}</b> (${escapeHtml(weekId)})`,
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
    'Change other fields with lines like:',
    '<code>title: The Mirror Challenge</code>',
    '<code>emoji: 🪞</code>  <code>category: couple</code>  <code>difficulty: easy</code>',
    '<code>players: 2</code>  <code>time: 10-15 min</code>  <code>link: https://…</code>',
    '',
    'Your text is used exactly as written. Send another reply any time before Monday to change the pick.',
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
