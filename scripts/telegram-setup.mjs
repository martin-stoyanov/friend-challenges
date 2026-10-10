#!/usr/bin/env node

/**
 * One-time Telegram setup for the weekly proposals bot.
 * The full checklist is in AUTOMATION_PLAN.md.
 *
 * Usage (TELEGRAM_BOT_TOKEN set in the environment for all but `secret`):
 *   node scripts/telegram-setup.mjs secret
 *       Prints a random webhook secret for TELEGRAM_WEBHOOK_SECRET.
 *   node scripts/telegram-setup.mjs chat-id
 *       After you've sent the bot a message, prints the chat ids it has seen.
 *       Only works while no webhook is set (see `unhook`).
 *   TELEGRAM_WEBHOOK_SECRET=… node scripts/telegram-setup.mjs webhook https://your-site
 *       Points Telegram at the site's function, with the secret, for messages
 *       and button taps only, and registers the /help command.
 *   node scripts/telegram-setup.mjs info
 *       Shows where the webhook points and its last delivery error.
 *   TELEGRAM_CHAT_ID=… node scripts/telegram-setup.mjs test
 *       Sends a test message to your chat.
 *   node scripts/telegram-setup.mjs unhook
 *       Removes the webhook (needed before `chat-id` works again).
 */

import { randomBytes } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import { telegramApi } from './lib/telegram.mjs';

export const WEBHOOK_PATH = '/.netlify/functions/telegram-webhook';

/** The function's full URL from a site URL, with or without a trailing slash. */
export function webhookUrl(siteUrl) {
  let url;
  try {
    url = new URL(siteUrl);
  } catch {
    throw new Error(`Not a URL: ${siteUrl}`);
  }
  if (url.protocol !== 'https:') throw new Error('Telegram only calls https webhooks');
  return `${url.origin}${WEBHOOK_PATH}`;
}

/** Telegram's rule for secret_token: 1–256 of A–Z, a–z, 0–9, _ and -. */
export function checkSecret(secret) {
  if (!secret) return 'TELEGRAM_WEBHOOK_SECRET is not set (make one with: node scripts/telegram-setup.mjs secret)';
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(secret)) {
    return 'TELEGRAM_WEBHOOK_SECRET may only use letters, digits, _ and -, up to 256 characters';
  }
  return null;
}

/** The distinct chats in a getUpdates result, newest first. */
export function chatsFromUpdates(updates) {
  const chats = new Map();
  for (const update of [...updates].reverse()) {
    const chat = (update.message ?? update.callback_query?.message)?.chat;
    if (!chat || chats.has(chat.id)) continue;
    const name = chat.title ?? [chat.first_name, chat.last_name].filter(Boolean).join(' ');
    chats.set(chat.id, { id: chat.id, type: chat.type, name, username: chat.username ?? null });
  }
  return [...chats.values()];
}

/** The setWebhook request (plan D9: the secret, and only the updates the bot reads). */
export function setWebhookBody(siteUrl, secret) {
  return {
    url: webhookUrl(siteUrl),
    secret_token: secret,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  };
}

async function main([command, arg]) {
  if (command === 'secret') {
    console.log(randomBytes(32).toString('hex'));
    return;
  }
  if (!process.env.TELEGRAM_BOT_TOKEN) throw new Error('Set TELEGRAM_BOT_TOKEN first (from @BotFather).');

  switch (command) {
    case 'chat-id': {
      let updates;
      try {
        updates = await telegramApi('getUpdates', { allowed_updates: ['message', 'callback_query'] });
      } catch (err) {
        if (/\(409\)/.test(err.message)) {
          throw new Error('A webhook is set, so Telegram keeps updates for it. Run `unhook`, then `chat-id`, then `webhook` again.');
        }
        throw err;
      }
      const chats = chatsFromUpdates(updates);
      if (!chats.length) {
        console.log('No messages yet. Send your bot any message in Telegram, then run this again.');
        return;
      }
      for (const chat of chats) {
        const who = [chat.name, chat.username && `@${chat.username}`].filter(Boolean).join(' ');
        console.log(`${chat.id}\t${chat.type}\t${who}`);
      }
      console.log('\nUse the id of your private chat as TELEGRAM_CHAT_ID.');
      return;
    }
    case 'webhook': {
      if (!arg) throw new Error('Give the site URL, e.g. webhook https://friendchallenges.martinstoyanov.dev');
      const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
      const problem = checkSecret(secret);
      if (problem) throw new Error(problem);
      const body = setWebhookBody(arg, secret);
      await telegramApi('setWebhook', body);
      await telegramApi('setMyCommands', { commands: [{ command: 'help', description: 'How to answer' }] });
      console.log(`✅ Webhook set to ${body.url}`);
      console.log('   Run `info` after your first reply to check deliveries.');
      return;
    }
    case 'info': {
      const info = await telegramApi('getWebhookInfo', {});
      console.log(`URL:             ${info.url || '(none)'}`);
      console.log(`Pending updates: ${info.pending_update_count}`);
      console.log(`Allowed updates: ${(info.allowed_updates ?? ['(all)']).join(', ')}`);
      if (info.last_error_message) {
        console.log(`Last error:      ${info.last_error_message} (${new Date(info.last_error_date * 1000).toISOString()})`);
      }
      return;
    }
    case 'test': {
      if (!process.env.TELEGRAM_CHAT_ID) throw new Error('Set TELEGRAM_CHAT_ID (from `chat-id`).');
      await telegramApi('sendMessage', {
        chat_id: process.env.TELEGRAM_CHAT_ID,
        text: '👋 The weekly challenge bot can reach you. Proposals arrive on Thursdays.',
      });
      console.log('📨 Sent. Check Telegram.');
      return;
    }
    case 'unhook': {
      await telegramApi('deleteWebhook', { drop_pending_updates: false });
      console.log('✅ Webhook removed.');
      return;
    }
    default:
      throw new Error('Usage: node scripts/telegram-setup.mjs secret | chat-id | webhook <site-url> | info | test | unhook');
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`❌ ${err.message}`);
    process.exit(1);
  });
}
