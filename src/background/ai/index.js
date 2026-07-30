/**
 * Provider-agnostic AI entry point: settings resolution, rate limiting,
 * retry with backoff, and JSON parsing.
 */

import { PROVIDERS, pickBestModel } from "../../shared/constants.js";
import { getSettings } from "../../shared/storage.js";
import { AiError, PROVIDER_ADAPTERS, MODEL_LISTERS } from "./providers.js";
import { parseJsonObject } from "./json.js";
import { Limiter } from "./limiter.js";

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 800;

const limiter = new Limiter({ rpm: 15, concurrency: 3 });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Resolve provider config from settings, applying per-provider defaults. */
export async function resolveConfig(kind = "scoring") {
  const settings = await getSettings();
  const provider = PROVIDERS[settings.provider] ? settings.provider : "gemini";
  const spec = PROVIDERS[provider];

  const model =
    (kind === "profile" ? settings.profileModel : settings.scoringModel)?.trim() ||
    (kind === "profile" ? spec.defaultProfileModel : spec.defaultScoringModel);

  limiter.configure({
    rpm: settings.rpm > 0 ? settings.rpm : spec.defaultRpm,
    concurrency: settings.concurrency,
  });

  return {
    provider,
    model,
    apiKey: settings.apiKey?.trim() || "",
    maxTokens: Math.max(400, Math.min(Number(settings.maxOutputTokens) || 2000, 16000)),
  };
}

/**
 * Run one JSON-returning AI call.
 * Retries transient failures (429/5xx/network) with exponential backoff + jitter,
 * honouring Retry-After when the provider supplies it.
 */
export async function callJson({
  system,
  prompt,
  schema,
  schemaName,
  documents = [],
  kind = "scoring",
  signal,
}) {
  const config = await resolveConfig(kind);

  if (!config.apiKey) {
    throw new AiError("No API key set — open the extension popup and add one under Settings.");
  }

  const adapter = PROVIDER_ADAPTERS[config.provider];
  if (!adapter) throw new AiError(`Unknown provider: ${config.provider}`);

  return limiter.run(async () => {
    let lastError;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      try {
        const { text, meta } = await adapter({
          apiKey: config.apiKey,
          model: config.model,
          system,
          prompt,
          schema,
          schemaName: schemaName || "result",
          documents,
          maxTokens: config.maxTokens,
          signal,
        });
        return { data: parseJsonObject(text), meta: { ...meta, provider: config.provider } };
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        lastError = error;

        const isLast = attempt === MAX_ATTEMPTS;
        // A parse failure is worth one more shot (models are non-deterministic);
        // a 4xx that isn't rate limiting will never succeed on retry.
        const retryable = error instanceof AiError ? error.retryable : true;
        if (isLast || !retryable) break;

        const backoff = BASE_BACKOFF_MS * 2 ** (attempt - 1);
        const jitter = Math.random() * 300;
        await sleep(Math.max(error?.retryAfterMs || 0, backoff) + jitter);
      }
    }

    // A dead model id is the one failure a user can't diagnose from the raw
    // provider text, so point at the control that fixes it.
    if (isModelUnavailable(lastError)) {
      throw new AiError(
        `Model "${config.model}" isn't available for this API key. Open the extension → Settings → Test to switch to a supported one. (${lastError.message})`,
        { status: lastError.status, code: "model_unavailable" },
      );
    }

    throw lastError;
  });
}

/**
 * Model ids the current API key can actually call, best-first.
 * Not rate-limited — it is a single cheap GET and the UI waits on it.
 */
export async function listModels() {
  const settings = await getSettings();
  const provider = PROVIDERS[settings.provider] ? settings.provider : "gemini";
  const apiKey = settings.apiKey?.trim();

  if (!apiKey) throw new AiError("No API key set — add one first.");

  const ids = await MODEL_LISTERS[provider](apiKey);
  const spec = PROVIDERS[provider];
  const usable = ids.filter((id) => !spec.exclude?.test(id));
  const best = pickBestModel(provider, ids);

  // Best-first, so the popup's suggestion list needs no further sorting.
  const ordered = best ? [best, ...usable.filter((id) => id !== best)] : usable;
  return { provider, models: ordered, recommended: best, total: ids.length };
}

/** True when a failure means "this model id is not usable with this key". */
export function isModelUnavailable(error) {
  if (!(error instanceof AiError)) return false;
  if (error.status === 404) return true;
  return error.status === 400 && /model|not found|not supported|deprecat/i.test(error.message);
}

export function queueDepth() {
  return limiter.pending;
}

export { AiError };
