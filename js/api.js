export function normalizeBaseUrl(url) {
  if (!url) return '';
  return url.trim().replace(/\/$/, '');
}

function authHeaders(settings) {
  const headers = {};
  if (settings.apiKey) {
    headers['Authorization'] = `Bearer ${settings.apiKey}`;
  }
  return headers;
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeout);
    return response;
  } catch (error) {
    clearTimeout(timeout);
    throw error;
  }
}

export async function pingServer(settings) {
  const base = normalizeBaseUrl(settings.baseUrl);
  if (!base) {
    return { ok: false, error: 'Base URL is not configured' };
  }

  try {
    const response = await fetchWithTimeout(
      `${base}/models`,
      { headers: authHeaders(settings) },
      4000
    );

    if (!response.ok) {
      return { ok: false, error: `Server returned ${response.status}` };
    }

    const data = await response.json();
    const models = (data.data || []).map(model => model.id);
    return { ok: true, models };
  } catch (error) {
    if (error.name === 'AbortError') {
      return { ok: false, error: 'Server did not respond in time' };
    }
    return { ok: false, error: 'Could not reach the server' };
  }
}

async function postChat(settings, messages, extraParams) {
  const base = normalizeBaseUrl(settings.baseUrl);
  try {
    return await fetchWithTimeout(
      `${base}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders(settings)
        },
        body: JSON.stringify({
          model: settings.model,
          messages,
          temperature: 0.5,
          max_tokens: 1536,
          // Thinking OFF for the translator: the system prompt already encodes the full
          // reasoning framework, so extended CoT costs ~30s/request and buys no measurable
          // accuracy here (A/B'd with tools/test-harness.py). Qwen3.x honours
          // enable_thinking, NOT reasoning_effort. With it off, content is the JSON directly.
          chat_template_kwargs: { enable_thinking: false },
          stream: false,
          ...extraParams
        })
      },
      90000
    );
  } catch {
    const err = new Error('Could not reach the server');
    err.kind = 'network';
    throw err;
  }
}

export async function chatJSON(settings, messages) {
  // Thinking is disabled at the request level (see postChat) — ~10x faster and accuracy
  // holds for this task, since the system prompt carries the reasoning framework. content
  // comes back as the JSON object directly. tools/test-harness.py guards this path.
  const response = await postChat(settings, messages, {});

  if (!response.ok) {
    const error = new Error(`Server error (${response.status})`);
    error.kind = 'http';
    throw error;
  }

  let data;
  try {
    data = await response.json();
  } catch {
    const error = new Error('The model returned something unreadable');
    error.kind = 'parse';
    throw error;
  }

  let content = data.choices[0].message.content;

  content = content.replace(/^```[^\n]*\n/, '').replace(/\n```\s*$/, '');

  const startIdx = content.indexOf('{');
  const endIdx = content.lastIndexOf('}');

  if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) {
    const error = new Error('The model returned something unreadable');
    error.kind = 'parse';
    throw error;
  }

  const jsonStr = content.slice(startIdx, endIdx + 1);

  try {
    return JSON.parse(jsonStr);
  } catch {
    // small models sometimes emit typographic quotes as JSON delimiters
    const repaired = jsonStr.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
    try {
      return JSON.parse(repaired);
    } catch {
      const error = new Error('The model returned something unreadable');
      error.kind = 'parse';
      throw error;
    }
  }
}
