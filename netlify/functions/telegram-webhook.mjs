/**
 * Telegram webhook: Martin's replies to the weekly proposals arrive here.
 *
 * Served at /.netlify/functions/telegram-webhook, which the SPA redirect in
 * netlify.toml does not touch. scripts/telegram-setup.mjs registers it with
 * Telegram along with the secret token.
 *
 * It keeps no state and never touches the repo (plan D4). It checks who sent
 * the update (D9), reads it with scripts/lib/reply.mjs, and starts a workflow
 * through workflow_dispatch (D8): apply-challenge.yml for a pick,
 * propose-challenges.yml for "more". That needs a token with Actions: write
 * only, which can't change the repo itself. The workflows apply the pick and
 * send the confirmation. Martin gets a quick acknowledgement here: a toast for
 * a button tap, a 👍 on his message for a text reply.
 *
 * Telegram retries any update that doesn't get a 2xx, so everything except a
 * wrong secret (401) or a missing setting (500) answers 200, even when the
 * update is dropped or something downstream failed.
 *
 * Environment: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, TELEGRAM_WEBHOOK_SECRET,
 * GITHUB_DISPATCH_TOKEN, GITHUB_REPO ("owner/name"), and optionally
 * GITHUB_DISPATCH_REF (the branch the workflows run on; default "master").
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { getNextMonday, getWeekId } from '../../scripts/lib/dates.mjs';
import { parseUpdate } from '../../scripts/lib/reply.mjs';
import { formatNotice, replyGuideText, sendMessage, telegramApi } from '../../scripts/lib/telegram.mjs';

const REQUIRED_ENV = [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'TELEGRAM_WEBHOOK_SECRET',
  'GITHUB_DISPATCH_TOKEN',
  'GITHUB_REPO',
];
// A Netlify function has about ten seconds. The dispatch gets one slice, then
// the acknowledgements run side by side in another.
const CALL_TIMEOUT_MS = 4_000;

// Hashing first gives both sides the same length, which timingSafeEqual needs,
// without leaking the secret's length through an early return.
function sameSecret(given, expected) {
  const digest = (value) => createHash('sha256').update(String(value)).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

class DispatchError extends Error {
  constructor(status) {
    super(status === 'timeout' ? 'GitHub did not answer in time' : `GitHub answered ${status}`);
    this.status = status;
  }
}

/** Starts a workflow on the deploy branch. Throws a DispatchError on failure. */
async function dispatch(env, fetchImpl, workflow, inputs, timeoutMs) {
  let response;
  try {
    response = await fetchImpl(
      `https://api.github.com/repos/${env.GITHUB_REPO}/actions/workflows/${workflow}/dispatches`,
      {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
          'Content-Type': 'application/json',
          'User-Agent': 'friend-challenges-telegram-webhook',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        body: JSON.stringify({ ref: env.GITHUB_DISPATCH_REF || 'master', inputs }),
        signal: AbortSignal.timeout(timeoutMs),
      }
    );
  } catch {
    // Never pass the error's own text on: with a malformed token it can quote it.
    throw new DispatchError('timeout');
  }
  if (response.status !== 204 && response.status !== 200) throw new DispatchError(response.status);
}

/** What Martin should hear when a hand-off fails. Built from the status only. */
function dispatchFailureNotice(err) {
  if (err.status === 'timeout') {
    return "⚠️ GitHub didn't answer in time. It may still go through; if no confirmation arrives in a few minutes, send it again.";
  }
  if (err.status === 401 || err.status === 403) {
    return "⚠️ GitHub refused the bot's token (it may have expired). Nothing changed. Make a new one and update GITHUB_DISPATCH_TOKEN on Netlify.";
  }
  if (err.status === 404 || err.status === 422) {
    return `⚠️ GitHub couldn't start the workflow (${err.status}). Nothing changed. Check that the workflows are on the deploy branch and GITHUB_REPO is right.`;
  }
  return `⚠️ GitHub answered ${err.status}. Nothing changed; try again in a minute.`;
}

/** The request handler, with its environment and fetch passed in for tests. */
export function createHandler({ env, fetchImpl = fetch, now = () => new Date(), timeoutMs = CALL_TIMEOUT_MS }) {
  // No retries: Telegram resends the whole update if we fail, and a 429 retry
  // could outlast the function.
  const telegram = { token: env.TELEGRAM_BOT_TOKEN, fetchImpl, retries: 0, timeoutMs };
  const ok = () => new Response('ok', { status: 200 });

  // Acknowledgements are a courtesy; a failed one is logged, never fatal.
  const quietly = (promise) => promise.catch((err) => console.warn(`Telegram call failed: ${err.message}`));
  const say = (message) => quietly(sendMessage(env.TELEGRAM_CHAT_ID, message, telegram));
  const toast = (callbackQueryId, text) =>
    callbackQueryId && quietly(telegramApi('answerCallbackQuery', { callback_query_id: callbackQueryId, text }, telegram));
  const thumbsUp = (messageId) =>
    messageId && quietly(telegramApi('setMessageReaction', {
      chat_id: env.TELEGRAM_CHAT_ID,
      message_id: messageId,
      reaction: [{ type: 'emoji', emoji: '👍' }],
    }, telegram));

  return async function handle(request) {
    if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

    const missing = REQUIRED_ENV.filter((name) => !env[name]);
    if (missing.length) {
      console.error(`telegram-webhook is missing settings: ${missing.join(', ')}`);
      return new Response('Not configured', { status: 500 });
    }
    if (!sameSecret(request.headers.get('x-telegram-bot-api-secret-token') ?? '', env.TELEGRAM_WEBHOOK_SECRET)) {
      return new Response('Unauthorized', { status: 401 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return ok(); // not JSON: nothing to act on, and nothing worth a retry
    }

    let result;
    try {
      result = parseUpdate(update, { upcomingWeekId: getWeekId(getNextMonday(now())) });
    } catch (err) {
      console.error(`Could not read update ${update?.update_id}: ${err.message}`);
      return ok();
    }

    // Only Martin's chat counts. Anyone else who finds the bot is ignored, but
    // logged, so a mistyped TELEGRAM_CHAT_ID shows up in the function log.
    if (result.chatId === null || String(result.chatId) !== String(env.TELEGRAM_CHAT_ID)) {
      if (result.chatId !== null) console.warn(`Ignored an update from chat ${result.chatId}.`);
      return ok();
    }
    const messageId = update.message?.message_id;

    switch (result.type) {
      case 'ignore':
        await toast(result.callbackQueryId);
        return ok();

      case 'help':
        await say({ text: replyGuideText() });
        return ok();

      case 'invalid':
        await Promise.all([
          toast(result.callbackQueryId, result.reason),
          say(formatNotice(`⚠️ ${result.reason} Send /help for the reply format.`)),
        ]);
        return ok();

      case 'pick':
      case 'more': {
        const isPick = result.type === 'pick';
        // workflow_dispatch inputs are all strings; apply-choice.mjs parses them.
        const [workflow, inputs] = isPick
          ? ['apply-challenge.yml', {
            week_id: result.weekId,
            pick: String(result.n),
            overrides: JSON.stringify(result.overrides),
            source: result.source,
          }]
          : ['propose-challenges.yml', { mode: 'more', week_id: result.weekId }];
        try {
          await dispatch(env, fetchImpl, workflow, inputs, timeoutMs);
        } catch (err) {
          console.error(`Dispatch to ${workflow} failed: ${err.message}`);
          await Promise.all([
            toast(result.callbackQueryId, 'That did not go through; see the message below.'),
            say(formatNotice(dispatchFailureNotice(err))),
          ]);
          return ok();
        }
        await Promise.all([
          toast(
            result.callbackQueryId,
            isPick ? `Picking #${result.n}… a confirmation follows.` : 'Finding more ideas… this takes a minute or two.'
          ),
          thumbsUp(messageId),
        ]);
        return ok();
      }

      default:
        return ok();
    }
  };
}

export default (request) => createHandler({ env: process.env })(request);
