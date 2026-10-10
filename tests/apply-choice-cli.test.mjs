// Runs scripts/apply-choice.mjs as the workflow does, in a throwaway copy of
// the scripts with Telegram unset, to pin the exit codes, the files it writes
// and what it tells the workflow through $GITHUB_OUTPUT.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendBatch, createProposals, markPicked } from '../scripts/lib/proposals.mjs';
import { formatDateLocal, getCurrentMonday, getNextMonday, getWeekId } from '../scripts/lib/dates.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let dir;

const draft = (title) => ({
  title,
  description: `${title}: sit back to back while one of you describes a photo and the other draws it blind.`,
  category: 'couple', difficulty: 'easy', emoji: '🎨', trendSource: 'TikTok',
  players: '2', timeEstimate: '10-15 min', exampleUrl: 'https://www.tiktok.com/search?q=blind', reasoning: 'r',
});
const upcoming = { weekOf: getNextMonday(), weekId: getWeekId(getNextMonday()) };

function writeProposalsFile(weekId, weekOf, pick) {
  let { file } = appendBatch(createProposals(weekId, weekOf), [draft('The Alpha Challenge'), draft('The Bravo Challenge')]);
  if (pick) file = markPicked(file, pick);
  fs.mkdirSync(path.join(dir, 'proposals'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'proposals', `${weekId}.json`), JSON.stringify(file));
}
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf-8'));

function run(args, { event, eventName } = {}) {
  const env = { ...process.env, GITHUB_OUTPUT: path.join(dir, 'output.txt') };
  delete env.TELEGRAM_BOT_TOKEN;
  delete env.TELEGRAM_CHAT_ID;
  delete env.GITHUB_EVENT_PATH;
  delete env.GITHUB_EVENT_NAME;
  if (event) {
    fs.writeFileSync(path.join(dir, 'event.json'), JSON.stringify(event));
    env.GITHUB_EVENT_PATH = path.join(dir, 'event.json');
    env.GITHUB_EVENT_NAME = eventName;
  }
  const result = spawnSync(process.execPath, [path.join(dir, 'scripts', 'apply-choice.mjs'), ...args], { env, encoding: 'utf-8' });
  const outputFile = path.join(dir, 'output.txt');
  return { ...result, output: fs.existsSync(outputFile) ? fs.readFileSync(outputFile, 'utf-8') : '' };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apply-cli-'));
  fs.cpSync(path.join(ROOT, 'scripts'), path.join(dir, 'scripts'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'writing-style.md'), path.join(dir, 'writing-style.md'));
  fs.mkdirSync(path.join(dir, 'src', 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src', 'data', 'challenges.json'), JSON.stringify([
    { id: '2026-w01', weekOf: '2026-01-05', title: 'Old', description: 'Old one.', category: 'both', difficulty: 'easy',
      emoji: '🧓', trendSource: 'TikTok', players: '2', timeEstimate: '5 min', exampleUrl: 'https://example.com' },
  ]));
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

test('a dispatch pick is applied, recorded, flagged as applied, and its confirmation deferred', () => {
  writeProposalsFile(upcoming.weekId, upcoming.weekOf);
  const message = path.join(dir, 'confirm.json');
  const { status, output } = run(['--message-out', message], {
    eventName: 'repository_dispatch',
    event: { client_payload: { weekId: upcoming.weekId, n: 2, overrides: { title: 'The Mirror Challenge' }, source: 'reply' } },
  });
  assert.equal(status, 0);
  assert.match(output, /^applied=true$/m);
  const [top] = readJson('src/data/challenges.json');
  assert.deepEqual([top.id, top.title], [upcoming.weekId, 'The Mirror Challenge']);
  assert.equal(readJson(`proposals/${upcoming.weekId}.json`).pick.source, 'reply');
  assert.match(readJson('confirm.json').text, /#2 is set for the week of/);
});

test('a bad pick from Telegram is answered and exits 0 without applying', () => {
  writeProposalsFile(upcoming.weekId, upcoming.weekOf);
  const { status, output, stdout } = run([], {
    eventName: 'repository_dispatch',
    event: { client_payload: { weekId: upcoming.weekId, n: 7, overrides: {}, source: 'button' } },
  });
  assert.equal(status, 0);
  assert.equal(output, '', 'nothing for the workflow to commit');
  assert.match(stdout, /There's no #7/);
  assert.equal(readJson('src/data/challenges.json').length, 1);
});

test('a bad pick on the command line exits 1', () => {
  writeProposalsFile(upcoming.weekId, upcoming.weekOf);
  assert.equal(run(['--pick', '9', '--week-id', upcoming.weekId]).status, 1);
  assert.equal(run(['--pick', 'x']).status, 1);
});

test('fallback: applies #1 with the fallback heading, then does nothing the second time', () => {
  writeProposalsFile(upcoming.weekId, upcoming.weekOf);
  const first = run(['--fallback']);
  assert.equal(first.status, 0);
  assert.match(first.output, /^applied=true$/m);
  assert.match(first.stdout, /No pick by Sunday, so #1 is set/);
  assert.equal(readJson('src/data/challenges.json')[0].title, 'The Alpha Challenge');

  fs.rmSync(path.join(dir, 'output.txt'));
  const second = run(['--fallback']);
  assert.equal(second.status, 0);
  assert.equal(second.output, '');
  assert.match(second.stdout, /already has a challenge/);
});

test('fallback re-applies a recorded pick under its own source, without the fallback heading', () => {
  writeProposalsFile(upcoming.weekId, upcoming.weekOf, { n: 2, source: 'reply', overrides: { title: 'The Mirror Challenge' } });
  const { status, stdout } = run(['--fallback']);
  assert.equal(status, 0);
  assert.doesNotMatch(stdout, /No pick by Sunday/);
  assert.equal(readJson('src/data/challenges.json')[0].title, 'The Mirror Challenge');
  assert.equal(readJson(`proposals/${upcoming.weekId}.json`).pick.source, 'reply');
});

test('fallback with nothing proposed asks the workflow to generate', () => {
  const { status, output } = run(['--fallback']);
  assert.equal(status, 0);
  assert.match(output, /^generate=true$/m);
  assert.doesNotMatch(output, /applied/);
});

test('the live week says so in its confirmation', () => {
  const weekOf = getCurrentMonday();
  writeProposalsFile(getWeekId(weekOf), weekOf);
  const { status, stdout } = run(['--pick', '1', '--week-id', getWeekId(weekOf)]);
  assert.equal(status, 0);
  assert.equal(weekOf <= formatDateLocal(new Date()), true);
  assert.match(stdout, /already live/);
});
