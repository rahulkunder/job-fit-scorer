/**
 * MV3 service worker — message router.
 *
 * Listeners are registered synchronously at module top level: the worker is
 * torn down when idle and revived by an incoming message, so anything
 * registered after an await would miss the event that woke it.
 */

import {
  getProfiles,
  getActiveProfile,
  setActiveProfile,
  saveProfile,
  deleteProfile,
  getSettings,
  setSettings,
  getHistory,
  deleteHistoryEntry,
  updateHistoryEntry,
  clearHistory,
  getUsageBytes,
} from "../shared/storage.js";
import { fitProfileVersion } from "../shared/jobkey.js";
import { scoreJob, scoreBatch, lookupCached, generateFitProfile } from "./scoring.js";
import { enableSite, disableSite, isSiteEnabled, restoreSites } from "./sites.js";
import { resolveConfig, callJson, queueDepth, listModels, isModelUnavailable } from "./ai/index.js";

/** action -> async handler(payload, sender) */
const handlers = {
  /* --- profiles ---------------------------------------------------- */
  getProfiles: () => getProfiles(),
  getActiveProfile: () => getActiveProfile(),
  setActiveProfile: ({ id }) => setActiveProfile(id),
  deleteProfile: ({ id }) => deleteProfile(id),

  saveProfile: async ({ profile }) => {
    // Keep the fit-profile fingerprint in sync with its content.
    if (profile.fitProfile) profile.fitProfileVersion = fitProfileVersion(profile.fitProfile);
    return saveProfile(profile);
  },

  generateFitProfile: ({ cv, pdf }) => generateFitProfile(cv, pdf),

  /* --- settings ---------------------------------------------------- */
  getSettings: () => getSettings(),
  setSettings: ({ patch }) => setSettings(patch),

  listModels: () => listModels(),

  /**
   * Round-trip the configured model, and self-heal if that model id is dead.
   *
   * Providers retire ids and close older ones to new API keys, so a default
   * that worked last month can 404 on a fresh key. Rather than dead-ending the
   * user, ask the key which models it can actually call, switch to the best
   * one, save it, and retry.
   */
  testConnection: async () => {
    const ping = () =>
      callJson({
        system: "You are a connectivity check. Reply with JSON only.",
        prompt: 'Return exactly {"ok": true}.',
        schema: {
          type: "object",
          additionalProperties: false,
          properties: { ok: { type: "boolean" } },
          required: ["ok"],
        },
        schemaName: "ping",
        kind: "scoring",
      });

    const config = await resolveConfig("scoring");
    if (!config.apiKey) throw new Error("No API key set");

    try {
      const { data } = await ping();
      return { ok: data?.ok === true, provider: config.provider, model: config.model };
    } catch (error) {
      if (!isModelUnavailable(error)) throw error;

      const { models, recommended } = await listModels();
      if (!recommended) {
        throw new Error(
          `"${config.model}" is unavailable and this key offers no usable alternative (${models.length} models seen).`,
        );
      }

      await setSettings({ scoringModel: recommended, profileModel: recommended });
      const { data } = await ping();
      return {
        ok: data?.ok === true,
        provider: config.provider,
        model: recommended,
        switchedFrom: config.model,
      };
    }
  },

  /* --- scoring ----------------------------------------------------- */
  scoreJob: ({ jobData, profileId, mode, force }) => scoreJob(jobData, profileId, { mode, force }),
  scoreBatch: ({ jobs, profileId, mode }) => scoreBatch(jobs, profileId, { mode }),
  lookupCached: ({ jobs, profileId }) => lookupCached(jobs, profileId),
  queueDepth: () => ({ pending: queueDepth() }),

  /**
   * Everything a content script needs on load, in one round trip.
   * Content scripts never read storage directly — the worker is the single
   * reader/writer, and this keeps page-side state to one round trip.
   */
  getContext: async () => {
    const [profile, settings, profiles] = await Promise.all([
      getActiveProfile(),
      getSettings(),
      getProfiles(),
    ]);
    return {
      profile: profile
        ? { id: profile.id, name: profile.name, hasFitProfile: Boolean(profile.fitProfile) }
        : null,
      profileCount: profiles.length,
      hasApiKey: Boolean(settings.apiKey),
      settings: {
        autoScore: settings.autoScore,
        listingDots: settings.listingDots,
        quickScore: settings.quickScore,
      },
    };
  },

  /* --- history ----------------------------------------------------- */
  getHistory: ({ profileId }) => getHistory(profileId),
  deleteHistoryEntry: ({ profileId, jobKey }) => deleteHistoryEntry(profileId, jobKey),
  updateHistoryEntry: ({ profileId, jobKey, patch }) => updateHistoryEntry(profileId, jobKey, patch),
  clearHistory: ({ profileId }) => clearHistory(profileId),
  getUsageBytes: () => getUsageBytes(),

  /* --- optional sites ---------------------------------------------- */
  enableSite: ({ origin }) => enableSite(origin),
  disableSite: ({ origin }) => disableSite(origin),
  isSiteEnabled: ({ origin }) => isSiteEnabled(origin),

  openDashboard: async () => {
    await chrome.tabs.create({ url: chrome.runtime.getURL("src/dashboard/dashboard.html") });
    return { ok: true };
  },
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = handlers[message?.action];
  if (!handler) {
    sendResponse({ ok: false, error: `Unknown action: ${message?.action}` });
    return false;
  }

  Promise.resolve()
    .then(() => handler(message, sender))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => {
      console.error(`[job-fit-scorer] ${message.action} failed:`, error);
      sendResponse({ ok: false, error: error?.message || String(error) });
    });

  return true; // keep the channel open for the async response
});

chrome.runtime.onInstalled.addListener(() => {
  restoreSites().catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  restoreSites().catch(() => {});
});
