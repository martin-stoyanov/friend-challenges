/**
 * Anthropic Messages API call, optionally with the web_search tool, returning
 * the JSON value (object or array) the model was asked for.
 *
 * Raw fetch rather than the SDK, as the generator always has been, so the
 * scripts need no dependency beyond Node.
 */

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const MODEL = 'claude-sonnet-4-6';
// A server-side tool loop that runs long comes back as stop_reason "pause_turn";
// re-sending the paused turn resumes it. Bounded so a stuck loop can't spin.
const MAX_CONTINUATIONS = 3;
const MAX_RATE_LIMIT_RETRIES = 5;

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

async function postWithRetries(body, apiKey, { fetchImpl, sleepImpl }) {
  // Retry on rate limits (429) and transient server errors (5xx) with backoff.
  // The org's per-minute token bucket refills over ~60s, so we wait it out
  // rather than failing — this keeps unattended runs (e.g. the GitHub cron) reliable.
  for (let attempt = 0; ; attempt++) {
    const response = await fetchImpl('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body,
    });

    if (response.ok) return response.json();

    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt >= MAX_RATE_LIMIT_RETRIES) {
      const error = await response.text();
      throw new Error(`Claude API error (${response.status}): ${error}`);
    }

    // Honor the server's retry-after (seconds) when present, else exponential backoff.
    const retryAfter = Number(response.headers.get('retry-after'));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : Math.min(60_000, 2_000 * 2 ** attempt);
    console.warn(`⏳ ${response.status} from API — waiting ${Math.round(waitMs / 1000)}s before retry (${attempt + 1}/${MAX_RATE_LIMIT_RETRIES})...`);
    await sleepImpl(waitMs);
  }
}

/**
 * Sends one prompt and returns the parsed JSON reply.
 *
 * Options: maxTokens (default 2048), maxSearches (web_search uses; 0 sends no
 * tools; default 1), and fetchImpl/sleepImpl for tests.
 *
 * Throws "Failed to parse JSON…" when the reply has no usable JSON, including
 * a reply cut off at max_tokens; callers retry on that prefix.
 */
export async function callClaude(prompt, systemPrompt, {
  maxTokens = 2048,
  maxSearches = 1,
  fetchImpl = fetch,
  sleepImpl = sleep,
} = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('❌ ANTHROPIC_API_KEY environment variable is required');
    console.error('   Set it with: ANTHROPIC_API_KEY=sk-ant-... node scripts/generate-challenge.mjs');
    process.exit(1);
  }

  const request = {
    model: MODEL,
    max_tokens: maxTokens,
    system: systemPrompt,
    ...(maxSearches > 0 && {
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: maxSearches }],
    }),
    messages: [{ role: 'user', content: prompt }],
  };

  let data = await postWithRetries(JSON.stringify(request), apiKey, { fetchImpl, sleepImpl });
  // Everything the assistant has produced this turn, across pauses. Each resume
  // re-sends all of it, so no earlier search drops out of the history.
  let content = data.content ?? [];
  for (let i = 0; data.stop_reason === 'pause_turn' && i < MAX_CONTINUATIONS; i++) {
    console.warn(`⏸️  Search loop paused; resuming (${i + 1}/${MAX_CONTINUATIONS})...`);
    const resumed = {
      ...request,
      messages: [request.messages[0], { role: 'assistant', content }],
    };
    data = await postWithRetries(JSON.stringify(resumed), apiKey, { fetchImpl, sleepImpl });
    content = [...content, ...(data.content ?? [])];
  }

  if (data.stop_reason === 'refusal') {
    throw new Error(`Claude declined the request: ${data.stop_details?.explanation ?? 'no explanation given'}`);
  }

  // With web search the answer can be split across several text blocks (one per
  // citation run), sometimes after a line of preamble, so read them all.
  const text = content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
  if (!text) {
    throw new Error(`No text block in Claude response: ${JSON.stringify(content)}`);
  }

  const parsed = extractJson(text);
  if (parsed === undefined) {
    const cutOff = data.stop_reason === 'max_tokens' ? ' (cut off at max_tokens)' : '';
    throw new Error(`Failed to parse JSON from Claude response${cutOff}:\n${text}`);
  }
  return parsed;
}
