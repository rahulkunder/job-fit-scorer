/**
 * Provider adapters. Each exposes `call(request) -> { text, meta }` and throws
 * an `AiError` on failure.
 *
 * All three request structured/JSON-constrained output where the provider
 * supports it. json.js still parses defensively — constrained decoding reduces
 * malformed output, it does not eliminate it across every model.
 */

export class AiError extends Error {
  constructor(message, { status = 0, retryable = false, retryAfterMs = 0, code = "" } = {}) {
    super(message);
    this.name = "AiError";
    this.status = status;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
    this.code = code;
  }
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);

function retryAfterMs(response) {
  const header = response.headers.get("retry-after");
  if (!header) return 0;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 60_000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, Math.min(date - Date.now(), 60_000)) : 0;
}

/**
 * Google returns "Request contains an invalid argument." with the actual cause
 * buried in error.details[].fieldViolations — surface it, or the message is
 * useless for diagnosis.
 */
function geminiError(body) {
  const error = body?.error;
  if (!error) return null;

  const violations = (error.details || [])
    .flatMap((detail) => detail.fieldViolations || [])
    .map((v) => [v.field, v.description].filter(Boolean).join(": "))
    .filter(Boolean);

  return violations.length ? `${error.message} (${violations.join("; ")})` : error.message;
}

async function readError(response, extract) {
  let detail = "";
  try {
    const body = await response.json();
    detail = extract(body) || JSON.stringify(body).slice(0, 300);
  } catch {
    detail = response.statusText;
  }
  throw new AiError(`${response.status} ${detail}`, {
    status: response.status,
    retryable: RETRYABLE_STATUS.has(response.status),
    retryAfterMs: retryAfterMs(response),
  });
}

async function postJson(url, { headers, body, signal }) {
  try {
    return await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    // fetch() only rejects on network/CORS failure.
    throw new AiError(`Network error: ${error.message}`, { retryable: true });
  }
}

/* ------------------------------------------------------------------ */
/* Google Gemini                                                       */
/* ------------------------------------------------------------------ */

/**
 * Note on thinking configuration: Gemini deliberately gets none.
 *
 * The 2.5 generation used `generationConfig.thinkingConfig.thinkingBudget`;
 * 3.x replaced it with a thinking-level field. Sending either to the wrong
 * generation yields a bare `400 Request contains an invalid argument`, and the
 * user picks the model, so we cannot know which shape applies. Omitting it is
 * the only body that is valid on every generation — the cost is that models
 * which think by default spend some of `maxOutputTokens` doing so, which is
 * why the default budget is generous.
 */
async function callGemini(
  { apiKey, model, system, prompt, documents = [], maxTokens, signal },
  { minimal = false } = {},
) {
  const parts = [
    ...documents.map((doc) => ({ inline_data: { mime_type: doc.mediaType, data: doc.data } })),
    { text: prompt },
  ];

  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts }],
    generationConfig: minimal
      ? { maxOutputTokens: maxTokens }
      : { responseMimeType: "application/json", temperature: 0.2, maxOutputTokens: maxTokens },
  };

  const response = await postJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    { headers: { "x-goog-api-key": apiKey }, body, signal },
  );

  if (!response.ok) {
    // A 400 usually means some generationConfig field isn't valid for this
    // model. Retry once with the bare minimum: the prompts ask for JSON in
    // words too, and json.js can recover an object from prose, so a degraded
    // request still produces a usable answer.
    if (response.status === 400 && !minimal) {
      return callGemini(
        { apiKey, model, system, prompt, documents, maxTokens, signal },
        { minimal: true },
      );
    }
    return readError(response, geminiError);
  }

  const data = await response.json();

  if (data.promptFeedback?.blockReason) {
    throw new AiError(`Request blocked by Gemini safety filters (${data.promptFeedback.blockReason})`);
  }

  const candidate = data.candidates?.[0];
  const text = candidate?.content?.parts?.map((p) => p.text || "").join("") || "";

  if (!text) {
    const reason = candidate?.finishReason || "no candidates";
    throw new AiError(
      reason === "MAX_TOKENS"
        ? "Gemini hit the output token limit — raise Max output tokens in Settings"
        : `Gemini returned no content (${reason})`,
    );
  }

  return { text, meta: { usage: data.usageMetadata, model: data.modelVersion || model } };
}

/* ------------------------------------------------------------------ */
/* Anthropic Claude                                                    */
/* ------------------------------------------------------------------ */

async function callClaude({ apiKey, model, system, prompt, schema, documents = [], maxTokens, signal }) {
  const content = [
    ...documents.map((doc) => ({
      type: "document",
      source: { type: "base64", media_type: doc.mediaType, data: doc.data },
    })),
    { type: "text", text: prompt },
  ];

  const response = await postJson("https://api.anthropic.com/v1/messages", {
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      // Required for browser-originated calls; without it the request is
      // rejected before CORS preflight succeeds.
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: {
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content }],
      output_config: { format: { type: "json_schema", schema } },
    },
    signal,
  });

  if (!response.ok) return readError(response, (b) => b?.error?.message);

  const data = await response.json();

  // Check stop_reason before reading content — a refusal returns HTTP 200 with
  // empty or partial content.
  if (data.stop_reason === "refusal") {
    throw new AiError(
      `Claude declined this request${data.stop_details?.category ? ` (${data.stop_details.category})` : ""}`,
    );
  }

  const text = (data.content || [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");

  if (!text) {
    throw new AiError(
      data.stop_reason === "max_tokens"
        ? "Claude hit the output token limit — raise Max output tokens in Settings"
        : `Claude returned no text (${data.stop_reason || "unknown"})`,
    );
  }

  if (data.stop_reason === "max_tokens") {
    throw new AiError("Claude response was truncated — raise Max output tokens in Settings");
  }

  return { text, meta: { usage: data.usage, model: data.model } };
}

/* ------------------------------------------------------------------ */
/* OpenAI                                                              */
/* ------------------------------------------------------------------ */

async function callOpenAI({
  apiKey,
  model,
  system,
  prompt,
  schema,
  schemaName,
  documents = [],
  maxTokens,
  signal,
}) {
  // Plain string content when there are no attachments — some models are
  // pickier about the array form than the docs suggest.
  const userContent = documents.length
    ? [
        ...documents.map((doc) => ({
          type: "file",
          file: { filename: doc.name || "document.pdf", file_data: `data:${doc.mediaType};base64,${doc.data}` },
        })),
        { type: "text", text: prompt },
      ]
    : prompt;

  const response = await postJson("https://api.openai.com/v1/chat/completions", {
    headers: { authorization: `Bearer ${apiKey}` },
    body: {
      model,
      temperature: 0.2,
      max_tokens: maxTokens,
      response_format: {
        type: "json_schema",
        json_schema: { name: schemaName, strict: true, schema },
      },
      messages: [
        { role: "system", content: system },
        { role: "user", content: userContent },
      ],
    },
    signal,
  });

  if (!response.ok) return readError(response, (b) => b?.error?.message);

  const data = await response.json();
  const choice = data.choices?.[0];

  if (choice?.message?.refusal) {
    throw new AiError(`Model declined this request: ${choice.message.refusal}`);
  }
  if (choice?.finish_reason === "length") {
    throw new AiError("Response was truncated — raise Max output tokens in Settings");
  }

  const text = choice?.message?.content || "";
  if (!text) throw new AiError("OpenAI returned no content");

  return { text, meta: { usage: data.usage, model: data.model } };
}

/* ------------------------------------------------------------------ */
/* Model discovery                                                     */
/* ------------------------------------------------------------------ */

async function getJson(url, headers, signal, extract = (b) => b?.error?.message) {
  let response;
  try {
    response = await fetch(url, { headers, signal });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw new AiError(`Network error: ${error.message}`, { retryable: true });
  }
  if (!response.ok) return readError(response, extract);
  return response.json();
}

/**
 * List the model ids this API key can actually call.
 *
 * Providers retire ids and close older ones to new keys, so the authoritative
 * answer is whatever the key itself reports — not anything compiled in here.
 */
const MODEL_LISTERS = {
  async gemini(apiKey, signal) {
    const data = await getJson(
      "https://generativelanguage.googleapis.com/v1beta/models?pageSize=200",
      { "x-goog-api-key": apiKey },
      signal,
      geminiError,
    );
    return (data.models || [])
      // Only models that can do plain text generation are usable here.
      .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map((m) => String(m.name || "").replace(/^models\//, ""))
      .filter(Boolean);
  },

  async claude(apiKey, signal) {
    const data = await getJson(
      "https://api.anthropic.com/v1/models?limit=100",
      {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      signal,
    );
    return (data.data || []).map((m) => m.id).filter(Boolean);
  },

  async openai(apiKey, signal) {
    const data = await getJson(
      "https://api.openai.com/v1/models",
      { authorization: `Bearer ${apiKey}` },
      signal,
    );
    return (data.data || []).map((m) => m.id).filter(Boolean);
  },
};

export const PROVIDER_ADAPTERS = {
  gemini: callGemini,
  claude: callClaude,
  openai: callOpenAI,
};

export { MODEL_LISTERS };
