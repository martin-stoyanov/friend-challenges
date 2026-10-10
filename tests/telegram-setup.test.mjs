import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSecret, chatsFromUpdates, setWebhookBody, webhookUrl } from '../scripts/telegram-setup.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/telegram-setup.mjs', import.meta.url));

// Runs the CLI with Telegram stubbed: every call is logged, and `reply`
// decides the answer per method.
function runCli(args, { env = {}, reply = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-setup-'));
  try {
    const log = path.join(dir, 'calls.log');
    fs.writeFileSync(path.join(dir, 'stub.mjs'), `
      import fs from 'node:fs';
      const reply = ${JSON.stringify(reply)};
      globalThis.fetch = async (url, init) => {
        const method = String(url).split('/').at(-1);
        fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ method, body: JSON.parse(init.body) }) + '\\n');
        const r = reply[method] ?? { status: 200, body: { ok: true, result: true } };
        return new Response(JSON.stringify(r.body), { status: r.status });
      };
    `);
    fs.writeFileSync(log, '');
    const result = spawnSync(process.execPath, ['--import', path.join(dir, 'stub.mjs'), SCRIPT, ...args], {
      encoding: 'utf-8',
      env: { ...process.env, TELEGRAM_BOT_TOKEN: 'T', ...env },
    });
    const calls = fs.readFileSync(log, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    return { ...result, calls };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('webhookUrl points at the function whatever the site URL looks like', () => {
  const expected = 'https://friendchallenges.martinstoyanov.dev/.netlify/functions/telegram-webhook';
  for (const site of [
    'https://friendchallenges.martinstoyanov.dev',
    'https://friendchallenges.martinstoyanov.dev/',
    'https://friendchallenges.martinstoyanov.dev/archive?x=1',
  ]) {
    assert.equal(webhookUrl(site), expected, site);
  }
  assert.throws(() => webhookUrl('http://example.com'), /only calls https/);
  assert.throws(() => webhookUrl('example.com'), /Not a URL/);
});

test("checkSecret follows Telegram's secret_token rules", () => {
  assert.equal(checkSecret('a'.repeat(64)), null);
  assert.equal(checkSecret('abc_DEF-123'), null);
  assert.match(checkSecret(''), /not set/);
  assert.match(checkSecret('has space'), /letters, digits/);
  assert.match(checkSecret('x'.repeat(257)), /up to 256/);
});

test('setWebhook asks only for messages and taps, with the secret, dropping old updates', () => {
  assert.deepEqual(setWebhookBody('https://site.example/', 'S'), {
    url: 'https://site.example/.netlify/functions/telegram-webhook',
    secret_token: 'S',
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  });
});

test('chatsFromUpdates lists each chat once, newest first, with a readable name', () => {
  const updates = [
    { update_id: 1, message: { chat: { id: 5, type: 'private', first_name: 'Martin', last_name: 'S', username: 'ms' } } },
    { update_id: 2, message: { chat: { id: -100, type: 'group', title: 'Friends' } } },
    { update_id: 3, callback_query: { message: { chat: { id: 5, type: 'private', first_name: 'Martin' } } } },
    { update_id: 4, edited_message: { chat: { id: 9 } } },
  ];
  assert.deepEqual(chatsFromUpdates(updates), [
    { id: 5, type: 'private', name: 'Martin', username: null },
    { id: -100, type: 'group', name: 'Friends', username: null },
  ]);
  assert.deepEqual(chatsFromUpdates([]), []);
});

test('the CLI makes a usable secret and refuses to run without a token', () => {
  const secret = spawnSync(process.execPath, [SCRIPT, 'secret'], { encoding: 'utf-8' });
  assert.equal(secret.status, 0);
  assert.equal(checkSecret(secret.stdout.trim()), null);

  const env = { ...process.env };
  delete env.TELEGRAM_BOT_TOKEN;
  const noToken = spawnSync(process.execPath, [SCRIPT, 'info'], { encoding: 'utf-8', env });
  assert.equal(noToken.status, 1);
  assert.match(noToken.stderr, /Set TELEGRAM_BOT_TOKEN first/);
});

test('webhook sets the URL with the secret, then registers /help', () => {
  const { status, calls } = runCli(['webhook', 'https://friendchallenges.martinstoyanov.dev'], {
    env: { TELEGRAM_WEBHOOK_SECRET: 'abc_123' },
  });
  assert.equal(status, 0);
  assert.deepEqual(calls.map((c) => c.method), ['setWebhook', 'setMyCommands']);
  assert.deepEqual(calls[0].body, setWebhookBody('https://friendchallenges.martinstoyanov.dev', 'abc_123'));
  assert.deepEqual(calls[1].body.commands, [{ command: 'help', description: 'How to answer' }]);
});

test('webhook refuses a missing or malformed secret before calling Telegram', () => {
  for (const secret of ['', 'not ok!']) {
    const { status, calls, stderr } = runCli(['webhook', 'https://site.example'], { env: { TELEGRAM_WEBHOOK_SECRET: secret } });
    assert.equal(status, 1, secret);
    assert.equal(calls.length, 0, secret);
    assert.match(stderr, /TELEGRAM_WEBHOOK_SECRET/, secret);
  }
});

test('chat-id lists chats, and points to unhook while a webhook is set', () => {
  const listed = runCli(['chat-id'], {
    reply: { getUpdates: { status: 200, body: { ok: true, result: [{ update_id: 1, message: { chat: { id: 5, type: 'private', first_name: 'Martin' } } }] } } },
  });
  assert.equal(listed.status, 0);
  assert.match(listed.stdout, /^5\tprivate\tMartin$/m);

  const hooked = runCli(['chat-id'], {
    reply: { getUpdates: { status: 409, body: { ok: false, description: "Conflict: can't use getUpdates method while webhook is active" } } },
  });
  assert.equal(hooked.status, 1);
  assert.match(hooked.stderr, /Run `unhook`, then `chat-id`, then `webhook` again/);
});

test('test sends to the chat id; unhook keeps pending updates', () => {
  const sent = runCli(['test'], { env: { TELEGRAM_CHAT_ID: '5' } });
  assert.equal(sent.status, 0);
  assert.equal(sent.calls[0].method, 'sendMessage');
  assert.equal(sent.calls[0].body.chat_id, '5');
  const unhooked = runCli(['unhook']);
  assert.deepEqual(unhooked.calls, [{ method: 'deleteWebhook', body: { drop_pending_updates: false } }]);
});
