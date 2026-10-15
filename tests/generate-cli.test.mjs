// Runs scripts/generate-challenge.mjs the way propose-challenges.yml does, in a
// throwaway copy with Claude and Telegram stubbed, to pin --from-event,
// --batch-out and --restore-batch.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCurrentMonday, getNextMonday, getWeekId } from '../scripts/lib/dates.mjs';
import { appendBatch, createProposals } from '../scripts/lib/proposals.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const upcoming = { weekOf: getNextMonday(), weekId: getWeekId(getNextMonday()) };
let dir;

// Each Claude call returns fresh titles, so "more" never collides with a batch.
const STUB = `
import fs from 'node:fs';
let call = 0;
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  fs.appendFileSync(process.env.STUB_LOG, JSON.stringify({
    url: String(url).replace(/bot[^/]+/, 'bot<T>'),
    method: String(url).split('/').at(-1),
    prompt: body.messages?.[0]?.content,
    text: body.text,
  }) + '\\n');
  if (String(url).includes('api.telegram.org')) {
    return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
  }
  call++;
  const proposals = [0, 1, 2, 3].map((i) => ({
    // Letters only: the duplicate check ignores digits.
    title: 'The ' + ['Alpha', 'Bravo', 'Charlie', 'Delta'][i] + ' ' + ['One', 'Two', 'Three', 'Four'][call - 1] + ' Challenge',
    description: 'Sit back to back. One of you describes a photo while the other draws it blind, with no peeking and no hand gestures.',
    category: i % 2 ? 'friend' : 'couple', difficulty: 'easy', emoji: '🎨', trendSource: 'TikTok',
    players: '2', timeEstimate: '10-15 min', exampleUrl: 'https://www.tiktok.com/search?q=blind', reasoning: 'r',
  }));
  return new Response(
    JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(proposals) }] }),
    { headers: { 'content-type': 'application/json' } }
  );
};
`;

function run(args, { eventName, inputs } = {}) {
  const env = {
    ...process.env,
    ANTHROPIC_API_KEY: 'k',
    TELEGRAM_BOT_TOKEN: 'T',
    TELEGRAM_CHAT_ID: '42',
    STUB_LOG: path.join(dir, 'calls.log'),
    GITHUB_ACTIONS: 'true',
  };
  delete env.GITHUB_EVENT_PATH;
  delete env.GITHUB_EVENT_NAME;
  if (eventName) {
    env.GITHUB_EVENT_NAME = eventName;
    env.GITHUB_EVENT_PATH = path.join(dir, 'event.json');
    fs.writeFileSync(env.GITHUB_EVENT_PATH, JSON.stringify(inputs ? { inputs } : {}));
  }
  fs.writeFileSync(env.STUB_LOG, '');
  const result = spawnSync(
    process.execPath,
    ['--import', path.join(dir, 'stub.mjs'), path.join(dir, 'scripts', 'generate-challenge.mjs'), ...args],
    { env, encoding: 'utf-8' }
  );
  const calls = fs.readFileSync(env.STUB_LOG, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { ...result, calls };
}
const proposalsFile = (weekId) => path.join(dir, 'proposals', `${weekId}.json`);
const readFile = (weekId) => JSON.parse(fs.readFileSync(proposalsFile(weekId), 'utf-8'));

function seedBatch(weekId, weekOf, createdAt) {
  const drafts = ['The Seed A Challenge', 'The Seed B Challenge'].map((title) => ({
    title, description: 'Seed.', category: 'both', difficulty: 'easy', emoji: '🌱', trendSource: 'TikTok',
    players: '2', timeEstimate: '5 min', exampleUrl: 'https://www.tiktok.com/search?q=seed',
  }));
  const { file } = appendBatch(createProposals(weekId, weekOf), drafts, new Date(createdAt));
  fs.mkdirSync(path.join(dir, 'proposals'), { recursive: true });
  fs.writeFileSync(proposalsFile(weekId), JSON.stringify(file));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'generate-cli-'));
  fs.cpSync(path.join(ROOT, 'scripts'), path.join(dir, 'scripts'), { recursive: true });
  // The scripts import the Anthropic SDK; the copy resolves it from the repo's install.
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir');
  fs.copyFileSync(path.join(ROOT, 'writing-style.md'), path.join(dir, 'writing-style.md'));
  fs.mkdirSync(path.join(dir, 'src', 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'data', 'challenges.json'), '[]');
  fs.writeFileSync(path.join(dir, 'stub.mjs'), STUB);
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

test('the Thursday schedule proposes 4 for the coming week, sends them, and saves the batch', () => {
  const batchOut = path.join(dir, 'batch.json');
  const { status, calls, stderr } = run(['--from-event', '--batch-out', batchOut], { eventName: 'schedule' });
  assert.equal(status, 0, stderr);
  assert.deepEqual(readFile(upcoming.weekId).proposals.map((p) => p.n), [1, 2, 3, 4]);
  assert.equal(calls.filter((c) => c.method === 'sendMessage').length, 6, 'header, 4 proposals, footer');
  const saved = JSON.parse(fs.readFileSync(batchOut, 'utf-8'));
  assert.deepEqual([saved.weekId, saved.added.length], [upcoming.weekId, 4]);
});

test('"more" from the webhook adds a numbered batch to the named week', () => {
  seedBatch(upcoming.weekId, upcoming.weekOf, Date.now() - 60 * 60_000);
  const { status, stderr } = run(['--from-event'], {
    eventName: 'workflow_dispatch',
    inputs: { mode: 'more', week_id: upcoming.weekId, count: '4', dry_run: false },
  });
  assert.equal(status, 0, stderr);
  assert.deepEqual(readFile(upcoming.weekId).proposals.map((p) => [p.n, p.batch]), [
    [1, 1], [2, 1], [3, 2], [4, 2], [5, 2], [6, 2],
  ]);
});

test('a second "more" moments after the first stands down and says so', () => {
  seedBatch(upcoming.weekId, upcoming.weekOf, Date.now() - 30_000);
  const { status, stdout, calls } = run(['--from-event'], {
    eventName: 'workflow_dispatch',
    inputs: { mode: 'more', week_id: upcoming.weekId, count: '4', dry_run: false },
  });
  assert.equal(status, 0);
  assert.match(stdout, /went out moments ago/);
  assert.deepEqual(calls.map((c) => c.method), ['sendMessage'], 'no Claude call, one notice');
  assert.equal(readFile(upcoming.weekId).proposals.length, 2, 'no new batch');
});

test('"more" for a week with nothing proposed, or an archived week, is answered with exit 0', () => {
  const none = run(['--from-event'], { eventName: 'workflow_dispatch', inputs: { mode: 'more', week_id: upcoming.weekId } });
  assert.equal(none.status, 0);
  assert.equal(none.calls.length, 1);
  assert.equal(none.calls[0].method, 'sendMessage');

  const lastYear = getWeekId(`${Number(getCurrentMonday().slice(0, 4)) - 1}-06-01`);
  const archived = run(['--from-event'], { eventName: 'workflow_dispatch', inputs: { mode: 'more', week_id: lastYear } });
  assert.equal(archived.status, 0);
  assert.match(archived.stderr, /is in the archive now/);
});

test('an input that is not a week id is refused by the --from-event guard before anything runs', () => {
  for (const week_id of ['--backfill', '2026-w4', '../../etc']) {
    const { status, calls, stderr } = run(['--from-event'], { eventName: 'workflow_dispatch', inputs: { mode: 'new', week_id } });
    assert.equal(status, 1, week_id);
    assert.equal(calls.length, 0, week_id);
    assert.match(stderr, /week_id must look like 2026-w43/, week_id);
  }
});

test('the count input sets the batch size; junk falls back to 4; over 8 is refused', () => {
  const sized = (count) => run(['--from-event'], {
    eventName: 'workflow_dispatch',
    inputs: { mode: 'new', week_id: '', count, dry_run: 'true' },
  });
  assert.match(sized('2').stdout, /Proposing 2 challenge\(s\)/);
  assert.match(sized('lots').stdout, /Proposing 4 challenge\(s\)/);
  const tooMany = sized('9');
  assert.equal(tooMany.status, 1);
  assert.match(tooMany.stderr, /1 to 8 proposals/);
});

test('dry_run proposes without saving or sending', () => {
  const { status, calls } = run(['--from-event'], { eventName: 'workflow_dispatch', inputs: { mode: 'new', week_id: '', count: '2', dry_run: 'true' } });
  assert.equal(status, 0);
  assert.equal(fs.existsSync(proposalsFile(upcoming.weekId)), false);
  assert.equal(calls.some((c) => c.method === 'sendMessage'), false);
});

test('a live batch is refused outside GitHub Actions; a dry run is fine', () => {
  const local = (args) => {
    const env = { ...process.env, ANTHROPIC_API_KEY: 'k', TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: '42', STUB_LOG: path.join(dir, 'calls.log') };
    delete env.GITHUB_ACTIONS;
    fs.writeFileSync(env.STUB_LOG, '');
    return spawnSync(process.execPath, ['--import', path.join(dir, 'stub.mjs'), path.join(dir, 'scripts', 'generate-challenge.mjs'), ...args], { env, encoding: 'utf-8' });
  };
  const live = local(['--propose', '4']);
  assert.equal(live.status, 1);
  assert.match(live.stderr, /sent from GitHub Actions/);
  assert.equal(local(['--propose', '2', '--dry-run']).status, 0);
});

test('Thursday tells Martin when the week was already filled outside Telegram', () => {
  fs.writeFileSync(path.join(dir, 'src', 'data', 'challenges.json'), JSON.stringify([{
    id: upcoming.weekId, weekOf: upcoming.weekOf, title: 'The Backfilled Challenge', description: 'x', category: 'both',
    difficulty: 'easy', emoji: '📦', trendSource: 'TikTok', players: '2', timeEstimate: '5 min', exampleUrl: 'https://example.com',
  }]));
  const { status, calls } = run(['--from-event'], { eventName: 'schedule' });
  assert.equal(status, 0);
  assert.deepEqual(calls.map((c) => c.method), ['sendMessage'], 'one notice, no Claude call');
});

test('--restore-batch puts a sent batch back after a reset, without calling anyone', () => {
  const batchOut = path.join(dir, 'batch.json');
  assert.equal(run(['--from-event', '--batch-out', batchOut], { eventName: 'schedule' }).status, 0);
  fs.rmSync(proposalsFile(upcoming.weekId)); // the reset to a master without it
  const { status, calls } = run(['--restore-batch', batchOut]);
  assert.equal(status, 0);
  assert.equal(calls.length, 0);
  assert.deepEqual(readFile(upcoming.weekId).proposals.map((p) => p.n), [1, 2, 3, 4]);
});

test('a hint from the event reaches the proposals prompt and the batch header', () => {
  seedBatch(upcoming.weekId, upcoming.weekOf, Date.now() - 60 * 60_000);
  const { status, calls, stderr } = run(['--from-event'], {
    eventName: 'workflow_dispatch',
    inputs: { mode: 'more', week_id: upcoming.weekId, count: '4', dry_run: false, hint: '  something   with music ' },
  });
  assert.equal(status, 0, stderr);
  const claude = calls.find((c) => c.url.includes('anthropic'));
  assert.match(claude.prompt, /Martin asked for ideas around: "something with music"\. Every challenge should fit that theme, but only as a real trend/);
  const header = calls.find((c) => c.method === 'sendMessage');
  assert.match(header.text, /4 more ideas around "something with music" for the week of/);
});

test('a hint that looks like a flag stays text; an overlong hint is refused', () => {
  seedBatch(upcoming.weekId, upcoming.weekOf, Date.now() - 60 * 60_000);
  const sneaky = run(['--from-event'], {
    eventName: 'workflow_dispatch',
    inputs: { mode: 'more', week_id: upcoming.weekId, count: '2', dry_run: 'true', hint: '--backfill' },
  });
  assert.equal(sneaky.status, 0, sneaky.stderr);
  assert.match(sneaky.stdout, /Proposing 2 challenge\(s\) for week of .* around "--backfill"/, 'still a propose run, with the hint as text');
  assert.match(sneaky.calls.find((c) => c.url.includes('anthropic')).prompt, /ideas around: "--backfill"/);

  const long = run(['--from-event'], {
    eventName: 'workflow_dispatch',
    inputs: { mode: 'more', week_id: upcoming.weekId, hint: 'x'.repeat(201) },
  });
  assert.equal(long.status, 1);
  assert.match(long.stderr, /at most 200 characters/);
  assert.equal(long.calls.length, 0);
});

test('without a hint the prompt has no theme line', () => {
  const { calls } = run(['--from-event'], { eventName: 'schedule' });
  assert.doesNotMatch(calls.find((c) => c.url.includes('anthropic')).prompt, /asked for ideas around/);
});

test('exactly 200 characters is a valid hint; a themed "more" is not held back as a double tap', () => {
  seedBatch(upcoming.weekId, upcoming.weekOf, Date.now() - 30_000);
  const { status, calls, stderr } = run(['--from-event'], {
    eventName: 'workflow_dispatch',
    inputs: { mode: 'more', week_id: upcoming.weekId, count: '4', dry_run: false, hint: 'y'.repeat(200) },
  });
  assert.equal(status, 0, stderr);
  assert.ok(calls.some((c) => c.url.includes('anthropic')), 'a fresh batch 30s old does not stop a themed request');
});

test('a hand-typed --hint needs a theme and --propose', () => {
  for (const args of [['--propose', '2', '--dry-run', '--hint'], ['--propose', '2', '--hint', '--dry-run']]) {
    const { status, stderr } = run(args);
    assert.equal(status, 1, args.join(' '));
    assert.match(stderr, /--hint needs a theme after it/);
  }
  const noPropose = run(['--hint', 'music', '--dry-run']);
  assert.equal(noPropose.status, 1);
  assert.match(noPropose.stderr, /--hint only works with --propose/);
});

test('a theme naming an audience replaces the usual mix', () => {
  seedBatch(upcoming.weekId, upcoming.weekOf, Date.now() - 60 * 60_000);
  const { calls } = run(['--from-event'], {
    eventName: 'workflow_dispatch',
    inputs: { mode: 'more', week_id: upcoming.weekId, count: '2', dry_run: 'true', hint: 'something for couples' },
  });
  assert.match(calls.find((c) => c.url.includes('anthropic')).prompt, /If the theme names an audience \(couples, friends\), that replaces the mix of audiences above\./);
});
