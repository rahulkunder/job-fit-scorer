/**
 * chrome.storage.local wrapper.
 *
 * Every read-modify-write goes through `withLock` so that two concurrent
 * callers (e.g. three tabs finishing a score at once) cannot clobber each
 * other's writes. chrome.storage has no transactions, so serialising in-process
 * is the only correctness guarantee available.
 */

import {
  STORAGE_KEYS,
  DEFAULT_SETTINGS,
  CACHE_LIMIT_PER_PROFILE,
  PROMPT_VERSION,
  SETTINGS_VERSION,
} from "./constants.js";

/** Per-key promise chain. Each entry is the tail of that key's write queue. */
const locks = new Map();

function withLock(key, fn) {
  const previous = locks.get(key) || Promise.resolve();
  // Swallow the predecessor's rejection so one failure doesn't poison the chain.
  const next = previous.catch(() => {}).then(fn);
  locks.set(
    key,
    next.catch(() => {}),
  );
  return next;
}

async function get(key, fallback) {
  const bag = await chrome.storage.local.get(key);
  return bag[key] === undefined ? fallback : bag[key];
}

/* ------------------------------------------------------------------ */
/* Profiles                                                            */
/* ------------------------------------------------------------------ */

export async function getProfiles() {
  return get(STORAGE_KEYS.profiles, []);
}

export async function getProfile(id) {
  const profiles = await getProfiles();
  return profiles.find((p) => p.id === id) || null;
}

/**
 * Insert or update a profile. Returns the persisted record (with its id).
 * `patch` is shallow-merged over the existing record when updating.
 */
export async function saveProfile(patch) {
  return withLock(STORAGE_KEYS.profiles, async () => {
    const profiles = await getProfiles();
    const now = Date.now();
    const id = patch.id || `p_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const index = profiles.findIndex((p) => p.id === id);

    const record =
      index >= 0
        ? { ...profiles[index], ...patch, id, updatedAt: now }
        : {
            id,
            name: "",
            cv: "",
            fitProfile: null,
            fitProfileVersion: null,
            createdAt: now,
            updatedAt: now,
            ...patch,
          };

    if (index >= 0) profiles[index] = record;
    else profiles.push(record);

    await chrome.storage.local.set({ [STORAGE_KEYS.profiles]: profiles });
    return record;
  });
}

export async function deleteProfile(id) {
  return withLock(STORAGE_KEYS.profiles, async () => {
    const profiles = (await getProfiles()).filter((p) => p.id !== id);
    const activeId = await get(STORAGE_KEYS.activeProfileId, null);
    const update = { [STORAGE_KEYS.profiles]: profiles };
    if (activeId === id) update[STORAGE_KEYS.activeProfileId] = profiles[0]?.id ?? null;
    await chrome.storage.local.set(update);

    // Drop that profile's cache partition too.
    const cache = await get(STORAGE_KEYS.cache, {});
    if (cache[id]) {
      delete cache[id];
      await chrome.storage.local.set({ [STORAGE_KEYS.cache]: cache });
    }
  });
}

export async function getActiveProfile() {
  const [profiles, activeId] = await Promise.all([
    getProfiles(),
    get(STORAGE_KEYS.activeProfileId, null),
  ]);
  return profiles.find((p) => p.id === activeId) || profiles[0] || null;
}

export async function setActiveProfile(id) {
  await chrome.storage.local.set({ [STORAGE_KEYS.activeProfileId]: id });
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

/**
 * Bring a stored settings blob up to the current schema.
 *
 * Pure and idempotent — applied on every read, persisted on the next write.
 * Without this, an install that saved a now-unsafe default keeps using it
 * forever, because a changed DEFAULT_SETTINGS never reaches an existing value.
 */
export function migrateSettings(stored = {}) {
  const out = { ...stored };

  if ((out.settingsVersion || 1) < 2) {
    // v1 shipped a 2000-token ceiling. Models that think by default spend part
    // of that budget reasoning, which can leave no room for the answer.
    if (!out.maxOutputTokens || out.maxOutputTokens <= 2000) {
      out.maxOutputTokens = DEFAULT_SETTINGS.maxOutputTokens;
    }
  }

  out.settingsVersion = SETTINGS_VERSION;
  return out;
}

export async function getSettings() {
  const stored = await get(STORAGE_KEYS.settings, {});
  return { ...DEFAULT_SETTINGS, ...migrateSettings(stored) };
}

export async function setSettings(patch) {
  return withLock(STORAGE_KEYS.settings, async () => {
    const merged = { ...(await getSettings()), ...patch };
    await chrome.storage.local.set({ [STORAGE_KEYS.settings]: merged });
    return merged;
  });
}

/* ------------------------------------------------------------------ */
/* Scored-jobs cache / history                                         */
/* ------------------------------------------------------------------ */

/**
 * A cache entry is only a hit when it was produced by the same prompt version
 * AND the same fit profile — regenerating a CV must invalidate old scores.
 */
function isFresh(entry, fitProfileVersion) {
  return (
    entry &&
    entry.promptVersion === PROMPT_VERSION &&
    entry.fitProfileVersion === fitProfileVersion
  );
}

export async function getCachedScore(profileId, jobKey, fitProfileVersion) {
  const cache = await get(STORAGE_KEYS.cache, {});
  const entry = cache?.[profileId]?.[jobKey];
  return isFresh(entry, fitProfileVersion) ? entry : null;
}

export async function putCachedScore(profileId, jobKey, entry) {
  return withLock(STORAGE_KEYS.cache, async () => {
    const cache = await get(STORAGE_KEYS.cache, {});
    const bucket = cache[profileId] || (cache[profileId] = {});

    // A full score always supersedes a quick (snippet-only) one.
    const existing = bucket[jobKey];
    if (existing?.mode === "full" && entry.mode === "quick") return existing;

    bucket[jobKey] = { ...entry, savedAt: Date.now() };

    const keys = Object.keys(bucket);
    if (keys.length > CACHE_LIMIT_PER_PROFILE) {
      keys
        .sort((a, b) => (bucket[a].savedAt || 0) - (bucket[b].savedAt || 0))
        .slice(0, keys.length - CACHE_LIMIT_PER_PROFILE)
        .forEach((k) => delete bucket[k]);
    }

    await chrome.storage.local.set({ [STORAGE_KEYS.cache]: cache });
    return bucket[jobKey];
  });
}

/** All cached entries for a profile, newest first, as a flat array. */
export async function getHistory(profileId) {
  const cache = await get(STORAGE_KEYS.cache, {});
  const bucket = cache[profileId] || {};
  return Object.entries(bucket)
    .map(([jobKey, entry]) => ({ jobKey, ...entry }))
    .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
}

export async function deleteHistoryEntry(profileId, jobKey) {
  return withLock(STORAGE_KEYS.cache, async () => {
    const cache = await get(STORAGE_KEYS.cache, {});
    if (cache[profileId]) {
      delete cache[profileId][jobKey];
      await chrome.storage.local.set({ [STORAGE_KEYS.cache]: cache });
    }
  });
}

export async function updateHistoryEntry(profileId, jobKey, patch) {
  return withLock(STORAGE_KEYS.cache, async () => {
    const cache = await get(STORAGE_KEYS.cache, {});
    const entry = cache?.[profileId]?.[jobKey];
    if (!entry) return null;
    cache[profileId][jobKey] = { ...entry, ...patch };
    await chrome.storage.local.set({ [STORAGE_KEYS.cache]: cache });
    return cache[profileId][jobKey];
  });
}

export async function clearHistory(profileId) {
  return withLock(STORAGE_KEYS.cache, async () => {
    const cache = await get(STORAGE_KEYS.cache, {});
    delete cache[profileId];
    await chrome.storage.local.set({ [STORAGE_KEYS.cache]: cache });
  });
}

/* ------------------------------------------------------------------ */
/* Custom sites (opt-in, generic JSON-LD extraction)                   */
/* ------------------------------------------------------------------ */

export async function getCustomSites() {
  return get(STORAGE_KEYS.customSites, []);
}

export async function setCustomSites(origins) {
  await chrome.storage.local.set({ [STORAGE_KEYS.customSites]: origins });
}

/** Approximate bytes used, for the dashboard's storage meter. */
export async function getUsageBytes() {
  if (typeof chrome.storage.local.getBytesInUse !== "function") return null;
  try {
    return await chrome.storage.local.getBytesInUse(null);
  } catch {
    return null;
  }
}
