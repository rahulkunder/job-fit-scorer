/**
 * Shared constants for background + extension pages (ESM).
 *
 * Content scripts do NOT import this — they are classic scripts with no storage
 * access and talk to the background worker over chrome.runtime messaging only.
 */

export const STORAGE_KEYS = {
  profiles: "profiles",
  activeProfileId: "activeProfileId",
  settings: "settings",
  cache: "scoredJobsCache",
  customSites: "customSites",
};

/**
 * Bumped whenever a prompt or the result schema changes in a way that makes
 * previously cached scores non-comparable. Cache entries stamped with an older
 * version are treated as misses.
 */
export const PROMPT_VERSION = 4;

/**
 * Bumped when a stored setting's meaning or safe default changes, so existing
 * installs get migrated instead of silently keeping a value that no longer
 * works. See `migrateSettings` in storage.js.
 */
export const SETTINGS_VERSION = 2;

/** Max cached scores retained per profile (oldest evicted first). */
export const CACHE_LIMIT_PER_PROFILE = 600;

export const CATEGORIES = [
  "Primary Fit",
  "Adjacent Fit",
  "Growth Stretch",
  "Reach",
  "Poor Fit",
];

/** Badge colours per role category (used by the widget + dashboard). */
export const CATEGORY_COLORS = {
  "Primary Fit": "#15803d",
  "Adjacent Fit": "#1d4ed8",
  "Growth Stretch": "#b45309",
  Reach: "#a16207",
  "Poor Fit": "#4b5563",
};

export const RECOMMENDATIONS = ["Apply", "Maybe", "Skip"];
export const SALARY_FLAGS = ["In range", "Below", "Above", "Unknown"];

/** Scoring rubric weights — mirrored in the prompt and enforced in schema.js. */
export const WEIGHTS = {
  skillsMatch: 40,
  experienceFit: 25,
  roleAlignment: 20,
  locationFit: 15,
};

/**
 * Provider registry.
 *
 * `defaultScoringModel` is only a starting guess. Providers retire model ids
 * and close old ones to new API keys without warning, so a hardcoded default
 * has a shelf life — the extension queries each provider's model list and can
 * re-pick automatically (see `pickBestModel` and the `listModels` adapters).
 *
 * `prefer` is an ordered list of patterns: the first that matches wins, with
 * ties broken by the highest version number in the id. `exclude` drops models
 * that cannot do JSON text generation at all.
 */
export const PROVIDERS = {
  gemini: {
    label: "Google Gemini",
    keyUrl: "https://aistudio.google.com/apikey",
    defaultScoringModel: "gemini-3.6-flash",
    defaultProfileModel: "gemini-3.6-flash",
    // Requests/minute the free tier tolerates comfortably.
    defaultRpm: 12,
    prefer: [/^gemini-[\d.]+-flash$/, /^gemini-[\d.]+-flash-lite$/, /flash/, /pro/],
    exclude: /embedding|aqa|imagen|veo|tts|audio|live|learnlm|gemma|thinking-exp/i,
  },
  claude: {
    label: "Anthropic Claude",
    keyUrl: "https://console.anthropic.com/settings/keys",
    // Haiku supports structured outputs and does not think by default, which
    // keeps per-scan latency and cost low. Override in Settings to use a larger
    // model — raise Max output tokens too if you pick a thinking model.
    defaultScoringModel: "claude-haiku-4-5",
    defaultProfileModel: "claude-haiku-4-5",
    defaultRpm: 30,
    prefer: [/haiku/, /sonnet/, /opus/],
    exclude: /^claude-[12]/i,
  },
  openai: {
    label: "OpenAI",
    keyUrl: "https://platform.openai.com/api-keys",
    defaultScoringModel: "gpt-4o-mini",
    defaultProfileModel: "gpt-4o-mini",
    defaultRpm: 30,
    prefer: [/^gpt-[\d.]+-mini$/, /mini/, /^gpt-/, /^o\d/],
    exclude:
      /embedding|whisper|tts|dall-e|sora|audio|realtime|moderation|babbage|davinci|instruct|transcribe|image|search|codex/i,
  },
};

/**
 * Choose the best model for a provider from a live list of ids.
 * Returns null when nothing usable is on offer.
 */
export function pickBestModel(providerId, ids = []) {
  const spec = PROVIDERS[providerId];
  if (!spec || !ids.length) return null;

  const version = (id) => {
    const found = id.match(/(\d+(?:[.-]\d+)?)/g);
    return found ? Math.max(...found.map((v) => parseFloat(v.replace("-", ".")) || 0)) : 0;
  };
  const rank = (id) => {
    const index = spec.prefer.findIndex((pattern) => pattern.test(id));
    return index === -1 ? spec.prefer.length : index;
  };

  const candidates = ids
    .filter((id) => !spec.exclude?.test(id))
    // Dated snapshots work but churn; prefer the stable alias when both exist.
    .sort((a, b) => {
      const byRank = rank(a) - rank(b);
      if (byRank) return byRank;
      const byDated = /\d{6,}/.test(a) - /\d{6,}/.test(b);
      if (byDated) return byDated;
      const byVersion = version(b) - version(a);
      if (byVersion) return byVersion;
      return a.length - b.length;
    });

  return candidates[0] || null;
}

export const DEFAULT_SETTINGS = {
  provider: "gemini",
  apiKey: "",
  scoringModel: "",
  profileModel: "",
  // Generous because current models think by default and thinking tokens count
  // against this budget — too tight and the response comes back empty.
  maxOutputTokens: 4000,
  /** Automatically score a job page as soon as it opens. */
  autoScore: true,
  /** Show cached score dots next to cards on search-results pages. */
  listingDots: true,
  /** Allow low-confidence "quick" scores from search-result snippets. */
  quickScore: false,
  /** Requests per minute ceiling; 0 = provider default. */
  rpm: 0,
  /** Max concurrent AI calls. */
  concurrency: 3,
};

/** Characters of job description sent to the model. */
export const MAX_JD_CHARS = 6000;
/** Characters of CV sent for one-time fit-profile generation. */
export const MAX_CV_CHARS = 24000;
