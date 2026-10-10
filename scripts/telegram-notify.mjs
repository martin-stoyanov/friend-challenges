#!/usr/bin/env node

/**
 * Sends one plain-text message to the weekly-proposals chat. The workflows run
 * it when a job fails, with the run's URL.
 *
 * Usage:
 *   TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... node scripts/telegram-notify.mjs "message"
 *   node scripts/telegram-notify.mjs --file confirm.json
 *       Sends a prepared HTML message ({ text, reply_markup? }), such as the
 *       confirmation apply-choice.mjs writes with --message-out.
 *
 * Exits 0 without sending when either variable is missing: the step runs after
 * a failure, and a second failure about notifications would bury the first.
 */

import fs from 'fs';
import { sendMessage, telegramApi } from './lib/telegram.mjs';

const USAGE = 'Usage: node scripts/telegram-notify.mjs "message" | --file message.json';
const args = process.argv.slice(2);
const fileIdx = args.indexOf('--file');
const file = fileIdx === -1 ? null : args[fileIdx + 1];
const text = fileIdx === -1 ? args.join(' ').trim() : '';
const { TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID } = process.env;

if (fileIdx !== -1 && !file) {
  console.error(USAGE);
  process.exit(1);
}
if (fileIdx === -1 && !text) {
  console.error(USAGE);
  process.exit(1);
}

let message = null;
if (file) {
  try {
    message = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    console.error(`❌ Can't read a message from ${file}: ${err.code === 'ENOENT' ? 'no such file' : err.message}`);
    process.exit(1);
  }
  if (typeof message?.text !== 'string' || !message.text) {
    console.error(`❌ ${file} has no "text" to send.`);
    process.exit(1);
  }
}

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.warn('⚠️  TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set; not sending:');
  console.warn(`   ${message?.text ?? text}`);
  process.exit(0);
}

try {
  if (message) {
    await sendMessage(TELEGRAM_CHAT_ID, message);
  } else {
    await telegramApi('sendMessage', {
      chat_id: TELEGRAM_CHAT_ID,
      text,
      link_preview_options: { is_disabled: true },
    });
  }
  console.log('📨 Sent to Telegram.');
} catch (err) {
  console.error(`❌ ${err.message}`);
  process.exit(1);
}
