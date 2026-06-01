// GitHub Models API — OpenAI-compatible endpoint authenticated with a GitHub OAuth token.
// No additional scope beyond a valid GitHub token is required.

const GITHUB_MODELS_BASE = "https://models.inference.ai.azure.com";

export class AIServiceError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

let _modelsCache = null;
let _modelsCacheAt = 0;
const MODELS_TTL = 60 * 60 * 1000; // 1 hour

export async function fetchModels() {
  if (_modelsCache && Date.now() - _modelsCacheAt < MODELS_TTL) {
    return _modelsCache;
  }
  const res = await fetch(`${GITHUB_MODELS_BASE}/models`);
  if (!res.ok) throw new AIServiceError("Failed to fetch models", res.status);
  const data = await res.json();
  _modelsCache = data
    .filter((m) => m.task === "chat-completion")
    .map((m) => ({ id: m.name, label: m.friendly_name }));
  _modelsCacheAt = Date.now();
  return _modelsCache;
}

/**
 * Send a chat completion request to GitHub Models.
 * Returns the raw Response so the caller can stream or read JSON.
 */
export async function chatCompletion(
  githubToken,
  messages,
  { model = "gpt-4o-mini", stream = false, signal } = {},
) {
  const res = await fetch(`${GITHUB_MODELS_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${githubToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, messages, stream }),
    signal,
  });

  if (!res.ok) {
    const retryAfter = res.headers.get("retry-after");
    if (res.status === 429) {
      throw new AIServiceError(
        `Rate limited by GitHub Models${retryAfter ? ` — retry after ${retryAfter}s` : ""}`,
        429,
      );
    }
    let errMsg;
    try {
      const body = await res.json();
      errMsg = body?.error?.message || body?.message || res.statusText;
    } catch {
      errMsg = res.statusText;
    }
    throw new AIServiceError(errMsg, res.status);
  }

  return res;
}
