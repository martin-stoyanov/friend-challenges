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
    eventName: 'workflow_dispatch',
    event: { inputs: { week_id: upcoming.weekId, pick: '2', overrides: JSON.stringify({ title: 'The Mirror Challenge' }), source: 'reply' } },
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
    eventName: 'workflow_dispatch',
    event: { inputs: { week_id: upcoming.weekId, pick: '7', overrides: '{}', source: 'button' } },
  });
  assert.equal(status, 0);
  assert.equal(output, '', 'nothing for the workflow to commit');
  assert.match(stdout, /There's no #7/);
  assert.equal(readJson('src/data/challenges.json').length, 1);
});

test('a bad pick on the command line, or from a hand-run, exits 1', () => {
  writeProposalsFile(upcoming.weekId, upcoming.weekOf);
  assert.equal(run(['--pick', '9', '--week-id', upcoming.weekId]).status, 1);
  assert.equal(run(['--pick', 'x']).status, 1);
  const handRun = run([], { eventName: 'workflow_dispatch', event: { inputs: { week_id: '', pick: '9', description: '' } } });
  assert.equal(handRun.status, 1);
});

test('a junk request from Telegram is still answered with exit 0', () => {
  const { status, stdout } = run([], {
    eventName: 'workflow_dispatch',
    event: { inputs: { week_id: '2026-w99x', pick: '1', overrides: '{}', source: 'number' } },
  });
  assert.equal(status, 0);
  assert.match(stdout, /not a week id/);
});

test('a hand-run with an empty week applies to the coming week', () => {
  writeProposalsFile(upcoming.weekId, upcoming.weekOf);
  const { status, output } = run([], { eventName: 'workflow_dispatch', event: { inputs: { week_id: '', pick: '1', description: 'Mine.' } } });
  assert.equal(status, 0);
  assert.match(output, /applied=true/);
  assert.equal(readJson('src/data/challenges.json')[0].description, 'Mine.');
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

// --- Free-form messages (docs/plans/telegram-freeform-replies.md, Step 14) ---

// Claude answers come from STUB_CLAUDE (a JSON array, used in order); every
// Telegram and GitHub call is logged to STUB_LOG.
const MESSAGE_STUB = `
import fs from 'node:fs';
const answers = JSON.parse(process.env.STUB_CLAUDE || '[]');
let next = 0;
const log = (entry) => fs.appendFileSync(process.env.STUB_LOG, JSON.stringify(entry) + '\\n');
globalThis.fetch = async (url, init) => {
  const body = JSON.parse(init.body);
  if (String(url).includes('api.anthropic.com')) {
    log({ to: 'claude', model: body.model, prompt: body.messages[0].content });
    const answer = answers[next++];
    if (!answer) throw new Error('no stubbed Claude answer left');
    return new Response(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: JSON.stringify(answer) }] }));
  }
  if (String(url).includes('api.github.com')) {
    log({ to: 'github', url: String(url), body });
    return new Response(null, { status: Number(process.env.STUB_GITHUB_STATUS || 204) });
  }
  log({ to: 'telegram', method: String(url).split('/').at(-1), text: body.text });
  return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }));
};
`;

const reading = (overrides) => ({
  action: 'pick',
  n: null,
  fields: { title: null, emoji: null, category: null, difficulty: null, players: null, time: null, link: null },
  description: null,
  descriptionBy: 'none',
  hint: null,
  question: null,
  ...overrides,
});

function runMessage(inputs, claudeAnswers, extraArgs = [], extraEnv = {}) {
  fs.writeFileSync(path.join(dir, 'message-stub.mjs'), MESSAGE_STUB);
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(log, '');
  fs.writeFileSync(path.join(dir, 'event.json'), JSON.stringify({ inputs: { source: 'message', reply_n: '', reply_text: '', ...inputs } }));
  const env = {
    ...process.env,
    GITHUB_OUTPUT: path.join(dir, 'output.txt'),
    GITHUB_EVENT_NAME: 'workflow_dispatch',
    GITHUB_EVENT_PATH: path.join(dir, 'event.json'),
    GITHUB_TOKEN: 'gh-token',
    GITHUB_REPOSITORY: 'martin-stoyanov/friend-challenges',
    GITHUB_REF_NAME: 'master',
    ANTHROPIC_API_KEY: 'k',
    TELEGRAM_BOT_TOKEN: 'T',
    TELEGRAM_CHAT_ID: '42',
    STUB_LOG: log,
    STUB_CLAUDE: JSON.stringify(claudeAnswers),
    ...extraEnv,
  };
  const result = spawnSync(
    process.execPath,
    ['--import', path.join(dir, 'message-stub.mjs'), path.join(dir, 'scripts', 'apply-choice.mjs'), ...extraArgs],
    { env, encoding: 'utf-8' }
  );
  const outputFile = path.join(dir, 'output.txt');
  return {
    ...result,
    output: fs.existsSync(outputFile) ? fs.readFileSync(outputFile, 'utf-8') : '',
    calls: fs.readFileSync(log, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l)),
  };
}

test('a message picks with his own description, through Opus, and the confirmation says how it was read', () => {
  writeProposalsFile(upcoming.weekId, upcoming.weekOf);
  const message = 'the bravo one, for friends. My description: Two of you draw blind while a third describes a photo.';
  const { status, output, calls } = runMessage(
    { week_id: upcoming.weekId, message },
    [reading({
      n: 2,
      fields: { ...reading().fields, category: 'friend' },
      description: 'Two of you draw blind while a third describes a photo.',
      descriptionBy: 'martin',
    })],
    ['--message-out', path.join(dir, 'confirm.json')]
  );
  assert.equal(status, 0);
  assert.match(output, /^applied=true$/m);
  assert.deepEqual(calls.map((c) => c.to), ['claude']);
  assert.equal(calls[0].model, 'claude-opus-5-5');
  assert.match(calls[0].prompt, /<message>\nthe bravo one, for friends\./);
  const [top] = readJson('src/data/challenges.json');
  assert.deepEqual([top.id, top.title, top.category, top.description], [
    upcoming.weekId, 'The Bravo Challenge', 'friend', 'Two of you draw blind while a third describes a photo.',
  ]);
  const { pick } = readJson(`proposals/${upcoming.weekId}.json`);
  assert.deepEqual([pick.n, pick.source, pick.descriptionBy], [2, 'message', 'martin']);
  assert.match(readJson('confirm.json').text, /I read this as: #2 The Bravo Challenge · for → friends · your description, word for word/);
});

test('a description Claude writes on request gets one style rewrite and is marked as Claude\'s', () => {
  writeProposalsFile(upcoming.weekId, upcoming.weekOf);
  const flagged = 'It is hilarious — draw blind while someone describes a photo.';
  const clean = 'Sit back to back. One of you describes a photo while the other draws it blind, with no peeking allowed at all.';
  const { status, calls } = runMessage(
    { week_id: upcoming.weekId, message: '2 but write a punchier description' },
    [reading({ n: 2, description: flagged, descriptionBy: 'claude' }), { description: clean }],
    ['--message-out', path.join(dir, 'confirm.json')]
  );
  assert.equal(status, 0);
  assert.deepEqual(calls.map((c) => c.to), ['claude', 'claude'], 'the reading, then one rewrite');
  assert.equal(readJson('src/data/challenges.json')[0].description, clean);
  assert.equal(readJson(`proposals/${upcoming.weekId}.json`).pick.descriptionBy, 'claude');
  assert.match(readJson('confirm.json').text, /I wrote the description, as you asked/);
});

test('an unclear message gets a question that quotes him; nothing is applied', () => {
  writeProposalsFile(upcoming.weekId, upcoming.weekOf);
  const { status, output, calls } = runMessage(
    { week_id: upcoming.weekId, message: 'the food one' },
    [reading({ action: 'clarify', question: 'Alpha or Bravo?' })]
  );
  assert.equal(status, 0);
  assert.equal(output, '');
  const sent = calls.find((c) => c.to === 'telegram');
  assert.match(sent.text, /^🤔 Alpha or Bravo\?\n\nYou wrote:\nthe food one\n\? · \d{4}-w\d{2}$/);
  assert.equal(readJson('src/data/challenges.json').length, 1);
});

test('an answer to that question can use the description from his first message', () => {
  writeProposalsFile(upcoming.weekId, upcoming.weekOf);
  const question = `🤔 Alpha or Bravo?\n\nYou wrote:\nthe food one, description: Pass a grape around using only your chins.\n? · ${upcoming.weekId}`;
  const { status, output } = runMessage(
    { week_id: upcoming.weekId, message: '2', reply_text: question },
    [reading({ n: 2, description: 'Pass a grape around using only your chins.', descriptionBy: 'martin' })]
  );
  assert.equal(status, 0);
  assert.match(output, /applied=true/);
  assert.equal(readJson('src/data/challenges.json')[0].description, 'Pass a grape around using only your chins.');
});

test('"more" with a theme starts the propose workflow with the hint and says so', () => {
  writeProposalsFile(upcoming.weekId, upcoming.weekOf);
  const { status, calls } = runMessage({ week_id: upcoming.weekId, message: 'none of these, something with music' }, [reading({ action: 'more', hint: 'music' })]);
  assert.equal(status, 0);
  const github = calls.find((c) => c.to === 'github');
  assert.equal(github.url, 'https://api.github.com/repos/martin-stoyanov/friend-challenges/actions/workflows/propose-challenges.yml/dispatches');
  assert.deepEqual(github.body, { ref: 'master', inputs: { mode: 'more', week_id: upcoming.weekId, hint: 'music' } });
  assert.match(calls.find((c) => c.to === 'telegram').text, /Finding more ideas around &quot;music&quot;/);
});

test('help sends the reply guide; a week with no proposals is answered without calling Claude', () => {
  writeProposalsFile(upcoming.weekId, upcoming.weekOf);
  const help = runMessage({ week_id: upcoming.weekId, message: 'how does this work?' }, [reading({ action: 'help' })]);
  assert.match(help.calls.find((c) => c.to === 'telegram').text, /How to answer/);

  const empty = runMessage({ week_id: '2030-w05', message: 'the first one' }, []);
  assert.equal(empty.status, 0);
  assert.deepEqual(empty.calls.map((c) => c.to), ['telegram']);
  assert.match(empty.calls[0].text, /Nothing has been proposed for 2030-w05 yet/);
});

test('the reading is cached for the run, so applying again calls Claude once', () => {
  writeProposalsFile(upcoming.weekId, upcoming.weekOf);
  const cache = path.join(dir, 'interpretation.json');
  const first = runMessage({ week_id: upcoming.weekId, message: 'the alpha one' }, [reading({ n: 1 })], ['--interpretation-cache', cache]);
  assert.equal(first.calls.filter((c) => c.to === 'claude').length, 1);
  const again = runMessage({ week_id: upcoming.weekId, message: 'the alpha one' }, [], ['--interpretation-cache', cache]);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.calls.filter((c) => c.to === 'claude').length, 0);
  assert.match(again.output, /applied=true/);
});

test('the fallback re-applying a pick keeps Claude as the author of its description', () => {
  writeProposalsFile(upcoming.weekId, upcoming.weekOf, {
    n: 2, source: 'message', overrides: { description: 'Written by Claude on request.' }, descriptionBy: 'claude',
  });
  assert.equal(run(['--fallback']).status, 0);
  const { pick } = readJson(`proposals/${upcoming.weekId}.json`);
  assert.deepEqual([pick.n, pick.descriptionBy], [2, 'claude']);
});

test('a rewrite that breaks more rules than the first draft is not used', () => {
  writeProposalsFile(upcoming.weekId, upcoming.weekOf);
  const first = 'Sit back to back. One of you describes a photo — the other draws it blind without peeking at all, which is the hard part.';
  const worse = 'It is hilarious — epic — draw.';
  const { status, calls } = runMessage(
    { week_id: upcoming.weekId, message: '2, rewrite the description please' },
    [reading({ n: 2, description: first, descriptionBy: 'claude' }), { description: worse }]
  );
  assert.equal(status, 0);
  assert.match(calls[1].prompt, /^Martin asked: 2, rewrite the description please/, 'the rewrite sees his request');
  assert.equal(readJson('src/data/challenges.json')[0].description, first);
});

test('a description Claude can only write too long becomes a question', () => {
  writeProposalsFile(upcoming.weekId, upcoming.weekOf);
  const long = 'Sit down and play. '.repeat(120);
  const { status, output, calls } = runMessage(
    { week_id: upcoming.weekId, message: '2, write a very detailed description' },
    [reading({ n: 2, description: long, descriptionBy: 'claude' }), { description: long }]
  );
  assert.equal(status, 0);
  assert.equal(output, '');
  assert.match(calls.find((c) => c.to === 'telegram').text, /came out too long/);
});

test('when GitHub refuses the new batch, he hears so and the run is flagged', () => {
  writeProposalsFile(upcoming.weekId, upcoming.weekOf);
  const { status, stdout, calls } = runMessage(
    { week_id: upcoming.weekId, message: 'none of these' },
    [reading({ action: 'more' })],
    [],
    { STUB_GITHUB_STATUS: '403' }
  );
  assert.equal(status, 0);
  assert.match(stdout, /::error::GitHub answered 403/);
  assert.match(calls.find((c) => c.to === 'telegram').text, /couldn't start a new batch/);
});

test('"more" for an archived week is answered without asking GitHub', () => {
  writeProposalsFile('2020-w01', '2019-12-30');
  const { status, calls } = runMessage({ week_id: '2020-w01', message: 'more please' }, [reading({ action: 'more' })]);
  assert.equal(status, 0);
  assert.equal(calls.some((c) => c.to === 'github'), false);
  assert.match(calls.find((c) => c.to === 'telegram').text, /in the archive now/);
});

test('a hand-run message with an empty week means the coming week', () => {
  writeProposalsFile(upcoming.weekId, upcoming.weekOf);
  const { status, output } = runMessage({ week_id: '', message: 'the alpha one' }, [reading({ n: 1 })]);
  assert.equal(status, 0);
  assert.match(output, /applied=true/);
});

test('a message Claude could not read is answered plainly and flags the run', () => {
  writeProposalsFile(upcoming.weekId, upcoming.weekOf);
  const { status, stdout, calls } = runMessage({ week_id: upcoming.weekId, message: 'the alpha one' }, []);
  assert.equal(status, 0);
  assert.match(stdout, /::error::Claude could not read the message/);
  assert.match(calls.find((c) => c.to === 'telegram').text, /couldn't read that message just now/);
});

test('a bad --message on the command line exits 1', () => {
  writeProposalsFile(upcoming.weekId, upcoming.weekOf);
  const env = { ...process.env };
  delete env.GITHUB_EVENT_PATH;
  delete env.GITHUB_EVENT_NAME;
  delete env.TELEGRAM_BOT_TOKEN;
  const result = spawnSync(process.execPath, [path.join(dir, 'scripts', 'apply-choice.mjs'), '--message', 'x', '--week-id', 'nope'], { env, encoding: 'utf-8' });
  assert.equal(result.status, 1);
})
