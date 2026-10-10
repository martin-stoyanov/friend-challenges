/**
 * Turns a Telegram update into what Martin asked for. Pure: no network, no
 * files. The webhook (netlify/functions/telegram-webhook.mjs) acts on the
 * result, and apply-choice.mjs checks the week and number against the
 * proposals file.
 *
 * Which proposal a reply means comes from, in order (plan D4):
 *   1. a button's callback data: "pick:<weekId>:<n>" or "more:<weekId>";
 *   2. the "#<n> · <weekId>" tag line of the message being replied to;
 *   3. a leading number for the upcoming week: "2" or "#2" alone on the first
 *      line, or "2:", "2." or "2)" before text.
 *
 * Everything after that is the reply body. Lines like "title: …" override a
 * field, and whatever is left is the description, used exactly as written
 * (plan D5).
 */

const WEEK_ID = String.raw`\d{4}-w\d{2}`;
const PICK_DATA = new RegExp(`^pick:(${WEEK_ID}):(\\d{1,3})$`);
const MORE_DATA = new RegExp(`^more:(${WEEK_ID})$`);
// The tag line formatProposal ends every proposal with (scripts/lib/telegram.mjs).
// Only the last line counts, so a tag-shaped line inside a description can't win.
const TAG_LINE = new RegExp(`(?:^|\\n)#(\\d{1,3}) · (${WEEK_ID})\\s*$`);
// "2", "#2", "2." or "2:" ending its line, or "2:" / "2." / "2)" before text.
// "2 people face each other" is not a pick: that reads as a description.
const LEADING_NUMBER = /^#?(\d{1,3})(?:[.:)]|(?=\r?\n)|$)/;
const ONLY_NUMBER = /^#?(\d{1,3})[.:)]?$/;
// Telegram content a person sends that has no text. Anything else without text
// is a service message (a pin, say) and gets no answer.
const CONTENT_KEYS = [
  'photo', 'video', 'animation', 'sticker', 'voice', 'video_note', 'audio',
  'document', 'contact', 'location', 'venue', 'poll', 'dice', 'caption',
];
const COMMAND = /^\/(\w+)(?:@\w+)?(?:\s|$)/;

// Reply keyword → challenge field.
const FIELD_KEYS = {
  title: 'title',
  emoji: 'emoji',
  category: 'category',
  difficulty: 'difficulty',
  players: 'players',
  time: 'timeEstimate',
  link: 'exampleUrl',
};
const FIELD_LINE = new RegExp(`^\\s*(${Object.keys(FIELD_KEYS).join('|')})\\s*:\\s*(.*)$`, 'i');
// Another "key:" inside a value means two fields were typed on one line.
const EMBEDDED_KEY = new RegExp(`(?:^|\\s)(${Object.keys(FIELD_KEYS).join('|')})\\s*:`, 'i');

const ENUMS = {
  category: ['friend', 'couple', 'both'],
  difficulty: ['easy', 'medium', 'hard'],
};

/**
 * Splits a reply body into field overrides and a description. Returns
 * { overrides } or { error }.
 */
export function parseBody(body) {
  const overrides = {};
  const descriptionLines = [];

  for (const line of body.split(/\r?\n/)) {
    const match = line.match(FIELD_LINE);
    if (!match) {
      descriptionLines.push(line.trimEnd());
      continue;
    }
    const key = match[1].toLowerCase();
    const field = FIELD_KEYS[key];
    let value = match[2].trim();
    if (!value) return { error: `"${key}:" needs a value after the colon.` };
    if (field !== 'title' && EMBEDDED_KEY.test(value)) {
      return { error: `Put each field on its own line ("${key}:" ran into another one).` };
    }

    if (ENUMS[field]) {
      value = value.toLowerCase();
      if (!ENUMS[field].includes(value)) {
        return { error: `${key} has to be one of: ${ENUMS[field].join(', ')}.` };
      }
    }
    if (field === 'exampleUrl' && !/^https?:\/\/\S+$/i.test(value)) {
      return { error: 'link has to be a single http(s) URL.' };
    }
    overrides[field] = value;
  }

  const description = descriptionLines.join('\n').trim();
  if (description) overrides.description = description;
  return { overrides };
}

function pick(weekId, n, body, source) {
  if (n < 1) return { type: 'invalid', reason: 'Proposal numbers start at 1.' };
  const parsed = parseBody(body);
  if (parsed.error) return { type: 'invalid', reason: parsed.error };
  return { type: 'pick', weekId, n, overrides: parsed.overrides, source };
}

/** The proposal a message is tagged with, if it is one of the bot's proposals. */
export function readTag(text) {
  const match = (text ?? '').match(TAG_LINE);
  return match ? { n: Number(match[1]), weekId: match[2] } : null;
}

function parseCallback(data) {
  const pickMatch = (data ?? '').match(PICK_DATA);
  if (pickMatch) return pick(pickMatch[1], Number(pickMatch[2]), '', 'button');
  const moreMatch = (data ?? '').match(MORE_DATA);
  if (moreMatch) return { type: 'more', weekId: moreMatch[1] };
  return { type: 'ignore', reason: 'unknown button' };
}

function parseText(message, upcomingWeekId) {
  const text = message.text.trim();
  if (!text) return { type: 'ignore', reason: 'empty message' };

  const command = text.match(COMMAND);
  if (command) {
    const name = command[1].toLowerCase();
    if (name === 'help' || name === 'start') return { type: 'help' };
    return { type: 'invalid', reason: `I don't know /${name}.` };
  }

  // A reply to a proposal (or to a confirmation, which carries the same tag).
  const tag = readTag(message.reply_to_message?.text);
  if (tag) {
    // A number alone on the first line picks that number in the same week, and
    // the lines after it are the body. Otherwise the whole text is the body.
    const [firstLine, ...rest] = text.split(/\r?\n/);
    const only = firstLine.trim().match(ONLY_NUMBER);
    if (only) return pick(tag.weekId, Number(only[1]), rest.join('\n'), 'reply');
    return pick(tag.weekId, tag.n, text, 'reply');
  }

  const leading = text.match(LEADING_NUMBER);
  if (leading) {
    return pick(upcomingWeekId, Number(leading[1]), text.slice(leading[0].length), 'number');
  }

  return {
    type: 'invalid',
    reason: 'Start with the proposal number, or reply to the proposal you want.',
  };
}

/**
 * Reads one Telegram update. Always returns an object with `type`:
 *   pick    { weekId, n, overrides, source: 'button' | 'reply' | 'number' }
 *   more    { weekId }
 *   help
 *   invalid { reason }  something Martin sent that needs an answer
 *   ignore  { reason }  nothing to answer (edits, other update kinds, bots)
 * plus `chatId`, and `callbackQueryId` for a button tap.
 */
export function parseUpdate(update, { upcomingWeekId }) {
  const callback = update?.callback_query;
  if (callback) {
    return {
      ...parseCallback(callback.data),
      chatId: callback.message?.chat?.id ?? null,
      callbackQueryId: callback.id,
    };
  }

  const message = update?.message;
  if (!message) return { type: 'ignore', reason: 'not a new message', chatId: null };
  const chatId = message.chat?.id ?? null;
  if (message.from?.is_bot) return { type: 'ignore', reason: 'from a bot', chatId };
  if (typeof message.text !== 'string') {
    if (CONTENT_KEYS.some((key) => key in message)) {
      return { type: 'invalid', reason: 'I can only read text messages.', chatId };
    }
    return { type: 'ignore', reason: 'service message', chatId };
  }
  return { ...parseText(message, upcomingWeekId), chatId };
}
