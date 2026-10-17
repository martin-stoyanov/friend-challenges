/**
 * Turns a finished Messages API response into the server-sent events the API
 * streams, so tests can fake a streamed reply (scripts/lib/claude.mjs streams
 * every call; docs/plans/modern-claude-calls.md, Step 21). Blocks arrive the
 * way the API sends them:
 * - text as text deltas, with each citation as a citations delta;
 * - thinking as thinking and signature deltas;
 * - a tool call with an empty input, then its input as a JSON delta;
 * - tool results and other blocks whole.
 */
const event = (name, data) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

/** The opening event alone, for a stream that breaks off after it. */
export function sseStart({ usage = {}, model = 'claude-test' } = {}) {
  return event('message_start', {
    type: 'message_start',
    message: {
      id: 'msg_test', type: 'message', role: 'assistant', model, content: [],
      stop_reason: null, stop_sequence: null,
      usage: { input_tokens: usage.input_tokens ?? 1, output_tokens: 0 },
    },
  });
}

function sseBody(message) {
  const { content = [], stop_reason = 'end_turn', stop_details = null, usage = {} } = message;
  const events = [sseStart(message)];
  const delta = (index, body) => events.push(event('content_block_delta', { type: 'content_block_delta', index, delta: body }));
  content.forEach((block, index) => {
    const start = (contentBlock) => events.push(event('content_block_start', { type: 'content_block_start', index, content_block: contentBlock }));
    if (block.type === 'text') {
      start({ type: 'text', text: '' });
      for (const citation of block.citations ?? []) delta(index, { type: 'citations_delta', citation });
      if (block.text) delta(index, { type: 'text_delta', text: block.text });
    } else if (block.type === 'thinking') {
      start({ type: 'thinking', thinking: '', signature: '' });
      if (block.thinking) delta(index, { type: 'thinking_delta', thinking: block.thinking });
      delta(index, { type: 'signature_delta', signature: block.signature ?? 'sig' });
    } else if (block.type === 'server_tool_use' || block.type === 'tool_use') {
      start({ ...block, input: {} });
      delta(index, { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) });
    } else {
      start(block);
    }
    events.push(event('content_block_stop', { type: 'content_block_stop', index }));
  });
  events.push(event('message_delta', {
    type: 'message_delta',
    delta: { stop_reason, stop_sequence: null, stop_details },
    usage: {
      output_tokens: usage.output_tokens ?? 1,
      ...(usage.server_tool_use && { server_tool_use: usage.server_tool_use }),
    },
  }));
  events.push(event('message_stop', { type: 'message_stop' }));
  return events.join('');
}

/** A 200 whose body streams the given text, then optionally fails or stalls. */
export function sseStream(text, { thenFail, delayMs = 0 } = {}) {
  const body = new ReadableStream({
    async start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      try {
        if (thenFail) controller.error(thenFail);
        else controller.close();
      } catch {
        // the reader gave up first (a deadline), which is the point of the delay
      }
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_stream' } });
}

export function sseResponse(message) {
  return new Response(sseBody(message), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** An `error` event after the stream has started, as the API sends an overload mid-stream. */
export function sseError(type = 'overloaded_error', message = 'Overloaded') {
  return sseStart() + event('error', { type: 'error', error: { type, message } });
}
