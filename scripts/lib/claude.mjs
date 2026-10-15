/**
 * Every Claude call in the scripts goes through callClaude, on the official
 * Anthropic SDK (docs/plans/modern-claude-calls.md, D20). It returns the JSON
 * value (object or array) the model was asked for.
 *
 * Callers: the generator (proposals and single challenges) and the Telegram
 * reply interpreter (Claude Opus 5.5 with a JSON schema;
 * docs/plans/telegram-freeform-replies.md, D16).
 */

import Anthropic from '@anthropic-ai/sdk';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Defaults for a caller that sets nothing; every current caller sets its own.
const MODEL = 'claude-opus-5-5';
const SEARCH_TOOL = 'web_search_20260209';
// Server-side refusal fallback: a declined request is re-run on the model
// Anthropic recommends for that refusal category, inside the same call.
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
// A server-side tool loop that runs long comes back as stop_reason "pause_turn";
// re-sending the paused turn resumes it (the SDK doesn't, for a plain call).
// Bounded so a stuck loop can't spin.
const MAX_CONTINUATIONS = 3;

/**
 * Pulls the JSON out of a model reply: a fenced block if there is one, else
 * the whole text, else the span from the first { or [ to the last } or ].
 * The last case covers a sentence of preamble before the JSON, which web
 * search replies sometimes have. Returns undefined when nothing parses.
 */
export function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], text];
  const start = text.search(/[[{]/);
  const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  if (start !== -1 && end > start) candidates.push(text.slice(start, end + 1));

  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    try {
      return JSON.parse(candidate.trim());
    } catch {
      // try the next candidate
    }
  }
  return undefined;
}

// The SDK retries 429s (following retry-after), 5xx and connection errors with
// backoff. By default up to five retries (six tries in all), since the org's
// per-minute token limit is tight and an unattended cron should wait it out.
// A caller someone is waiting on (the Telegram interpreter) asks for fewer and
// a shorter timeout instead.
const MAX_RETRIES = 5;
// The SDK's own default is 10 minutes per attempt. Non-streaming calls must
// also keep max_tokens at or below about 21k, which every caller does.
const TIMEOUT_MS = 10 * 60_000;

function createClient(apiKey, { fetchImpl, maxRetries, timeoutMs }) {
  return new Anthropic({
    apiKey,
    maxRetries,
    timeout: timeoutMs,
    // 'info' puts one line per request and per retry in the log (no keys or
    // headers), so a rate-limited run doesn't sit silent while it waits.
    logLevel: 'info',
    ...(fetchImpl && { fetch: fetchImpl }),
  });
}

/** An SDK error as one readable line, without the repeated status, keeping the cause. */
function describeApiError(err) {
  const detail = String(err.message ?? '').replace(new RegExp(`^${err.status ?? ''}\\s*`), '');
  const requestId = err.requestID ? ` [request ${err.requestID}]` : '';
  const cause = err.cause?.code ?? err.cause?.message;
  return `Claude API error (${err.status ?? 'no status'}): ${detail}${cause ? ` (${cause})` : ''}${requestId}`;
}

/**
 * Sends one prompt and returns the parsed JSON reply.
 *
 * Options:
 * - model (default claude-opus-5-5), maxTokens (default 2048);
 * - maxSearches: web_search uses; 0 sends no tools; default 1;
 * - effort: output_config.effort (low | medium | high | xhigh | max);
 * - schema: a JSON schema the reply must follow (output_config.format);
 * - fallbacks: 'default' opts into server-side refusal fallbacks;
 * - searchTool: the web search tool version (default web_search_20260209);
 * - maxRetries (default 5) and timeoutMs (default 10 minutes per attempt);
 * - fetchImpl for tests (the SDK's fetch).
 * Each call logs one line of usage (tokens in and out, stop reason).
 *
 * Throws "Failed to parse JSON…" when the reply has no usable JSON, including
 * a reply cut off at max_tokens; callers retry on that prefix.
 */
export async function callClaude(prompt, systemPrompt, {
  model = MODEL,
  maxTokens = 2048,
  maxSearches = 1,
  effort,
  schema,
  fallbacks,
  searchTool = SEARCH_TOOL,
  maxRetries = MAX_RETRIES,
  timeoutMs = TIMEOUT_MS,
  fetchImpl,
} = {}) {
  // Only the "default" form: the array form needs a different beta header.
  if (fallbacks !== undefined && fallbacks !== 'default') {
    throw new Error(`fallbacks must be 'default', got ${JSON.stringify(fallbacks)}`);
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('❌ ANTHROPIC_API_KEY environment variable is required');
    console.error('   Set it with: ANTHROPIC_API_KEY=sk-ant-... node scripts/generate-challenge.mjs');
    process.exit(1);
  }

  const outputConfig = {
    ...(effort && { effort }),
    ...(schema && { format: { type: 'json_schema', schema } }),
  };
  const request = {
    model,
    max_tokens: maxTokens,
    system: systemPrompt,
    ...(maxSearches > 0 && {
      tools: [{ type: searchTool, name: 'web_search', max_uses: maxSearches }],
    }),
    messages: [{ role: 'user', content: prompt }],
    ...(Object.keys(outputConfig).length && { output_config: outputConfig }),
    ...(fallbacks && { fallbacks }),
  };
  const client = createClient(apiKey, { fetchImpl, maxRetries, timeoutMs });
  const post = async (body) => {
    try {
      // fallbacks is a beta parameter, so it goes through the beta endpoint.
      return fallbacks
        ? await client.beta.messages.create({ ...body, betas: [FALLBACK_BETA] })
        : await client.messages.create(body);
    } catch (err) {
      // Same message shape as before the SDK, for callers and logs.
      if (err instanceof Anthropic.APIError) throw new Error(describeApiError(err), { cause: err });
      throw err;
    }
  };

  let data = await post(request);
  // Everything the assistant has produced this turn, across pauses. Each resume
  // re-sends all of it, so no earlier search drops out of the history.
  let content = data.content ?? [];
  for (let i = 0; data.stop_reason === 'pause_turn' && i < MAX_CONTINUATIONS; i++) {
    console.warn(`⏸️  Search loop paused; resuming (${i + 1}/${MAX_CONTINUATIONS})...`);
    const resumed = {
      ...request,
      messages: [request.messages[0], { role: 'assistant', content }],
    };
    data = await post(resumed);
    content = [...content, ...(data.content ?? [])];
  }

  const usage = data.usage ?? {};
  console.log(`🧾 ${data.model ?? model}: ${usage.input_tokens ?? '?'} tokens in, ${usage.output_tokens ?? '?'} out, ${data.stop_reason}`);

  if (data.stop_reason === 'refusal') {
    throw new Error(`Claude declined the request: ${data.stop_details?.explanation ?? 'no explanation given'}`);
  }

  // With web search the answer can be split across several text blocks (one per
  // citation run), sometimes after a line of preamble, so read them all. Thinking
  // blocks (Opus 5.5 returns them) and fallback blocks are not text.
  const text = content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
  if (!text) {
    // A reply cut off while still thinking has no text at all; that is the same
    // retryable failure as a cut-off answer.
    if (data.stop_reason === 'max_tokens') {
      throw new Error('Failed to parse JSON from Claude response (cut off at max_tokens before any answer)');
    }
    throw new Error(`No text block in Claude response: ${JSON.stringify(content)}`);
  }

  // With a schema the whole text is the JSON value, so parse it as is: a string
  // field that happens to contain a code fence must not be mistaken for the answer.
  let parsed;
  if (schema) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = extractJson(text);
    }
  } else {
    parsed = extractJson(text);
  }
  if (parsed === undefined) {
    const cutOff = data.stop_reason === 'max_tokens' ? ' (cut off at max_tokens)' : '';
    throw new Error(`Failed to parse JSON from Claude response${cutOff}:\n${text}`);
  }
  return parsed;
}
