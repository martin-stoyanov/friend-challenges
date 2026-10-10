/**
 * Anthropic Messages API call with the web_search tool, returning the JSON
 * object the model was asked for.
 */

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function callClaude(prompt, systemPrompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('❌ ANTHROPIC_API_KEY environment variable is required');
    console.error('   Set it with: ANTHROPIC_API_KEY=sk-ant-... node scripts/generate-challenge.mjs');
    process.exit(1);
  }

  const body = JSON.stringify({
    model: 'claude-sonnet-4-6',
    max_tokens: 2048,
    system: systemPrompt,
    tools: [
      {
        type: 'web_search_20250305',
        name: 'web_search',
        max_uses: 1,
      },
    ],
    messages: [
      { role: 'user', content: prompt },
    ],
  });

  // Retry on rate limits (429) and transient server errors (5xx) with backoff.
  // The org's per-minute token bucket refills over ~60s, so we wait it out
  // rather than failing — this keeps unattended runs (e.g. the GitHub cron) reliable.
  const maxRateLimitRetries = 5;
  let response;
  for (let attempt = 0; ; attempt++) {
    response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body,
    });

    if (response.ok) break;

    const retryable = response.status === 429 || response.status >= 500;
    if (!retryable || attempt >= maxRateLimitRetries) {
      const error = await response.text();
      throw new Error(`Claude API error (${response.status}): ${error}`);
    }

    // Honor the server's retry-after (seconds) when present, else exponential backoff.
    const retryAfter = Number(response.headers.get('retry-after'));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1000
      : Math.min(60_000, 2_000 * 2 ** attempt);
    console.warn(`⏳ ${response.status} from API — waiting ${Math.round(waitMs / 1000)}s before retry (${attempt + 1}/${maxRateLimitRetries})...`);
    await sleep(waitMs);
  }

  const data = await response.json();
  // Response may contain web_search_tool_use / web_search_tool_result blocks — find the final text block
  const textBlock = data.content.find(block => block.type === 'text');
  if (!textBlock) {
    throw new Error(`No text block in Claude response: ${JSON.stringify(data.content)}`);
  }
  const text = textBlock.text;

  // Extract JSON from the response (Claude may wrap it in markdown code fences)
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, text];
  const jsonStr = jsonMatch[1].trim();

  try {
    return JSON.parse(jsonStr);
  } catch {
    throw new Error(`Failed to parse JSON from Claude response:\n${text}`);
  }
}
