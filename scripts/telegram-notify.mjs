#!/usr/bin/env node

/**
 * Sends one plain-text message to the weekly-proposals chat. The workflows run
 * it when a job fails, with the run's URL.
 *
 * Usage:
 *   TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... node scripts/telegram-notify.mjs "message"
 *
 * Exits 0 without sending when either variable is missing: the step runs after
 * a failure, and a second failure about notifications would bury the first.
 */

import { telegramApi } from './lib/telegram.mjs';

const text = process.argv.slice(2).join(' ').trim();
const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = process.env;

if (!text) {
  console.error('Usage: node scripts/telegram-notify.mjs "message"');
  process.exit(1);
}

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.warn('⚠️  TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set; not sending:');
  console.warn(`   ${text}`);
  process.exit(0);
}

try {
  await telegramApi('sendMessage', {
    chat_id: TELEGRAM_CHAT_ID,
    text,
    link_preview_options: { is_disabled: true },
  });
  console.log('📨 Sent to Telegram.');
} catch (err) {
  console.error(`❌ ${err.message}`);
  process.exit(1);
}
