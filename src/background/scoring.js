/**
 * Scoring orchestration: cache lookup, in-flight de-duplication, AI call,
 * normalisation, persistence.
 */

import { PROMPT_VERSION } from "../shared/constants.js";
import { getProfile, getCachedScore, putCachedScore } from "../shared/storage.js";
import { jobKey as computeJobKey, fitProfileVersion } from "../shared/jobkey.js";
import {
  normalizeScore,
  normalizeFitProfile,
  SCORE_JSON_SCHEMA,
  FIT_PROFILE_JSON_SCHEMA,
} from "../shared/schema.js";
import { buildScoringPrompt, buildFitProfilePrompt } from "./ai/prompts.js";
import { callJson, AiError } from "./ai/index.js";

/**
 * Requests currently in flight, keyed by profile+job. LinkedIn's SPA can fire
 * the same scan two or three times as the DOM settles; without this every one
 * of those becomes a billed API call.
 */
const inFlight = new Map();

function meta(jobData) {
  return {
    title: jobData.title || "",
    company: jobData.company || "",
    location: jobData.location || "",
    salary: jobData.salary || "",
    site: jobData.site || "",
    url: jobData.url || "",
  };
}

/**
 * Score a job for a profile.
 * @param {object} jobData     extracted posting
 * @param {string} profileId
 * @param {object} options     { mode: 'full'|'quick', force: boolean }
 */
export async function scoreJob(jobData, profileId, { mode = "full", force = false } = {}) {
  const profile = await getProfile(profileId);
  if (!profile) throw new AiError("Profile not found");
  if (!profile.fitProfile) throw new AiError("This profile has no Fit Profile yet — generate one first.");

  const key = computeJobKey(jobData);
  const version = profile.fitProfileVersion || fitProfileVersion(profile.fitProfile);

  if (!force) {
    const cached = await getCachedScore(profileId, key, version);
    // A cached quick score does not satisfy a full-scan request.
    if (cached && !(mode === "full" && cached.result?.mode === "quick")) {
      return { jobKey: key, ...cached, cached: true };
    }
  }

  const dedupeKey = `${profileId}|${key}|${mode}`;
  if (inFlight.has(dedupeKey)) return inFlight.get(dedupeKey);

  const work = (async () => {
    const { system, prompt } = buildScoringPrompt(profile.fitProfile, jobData, mode);
    const { data, meta: callMeta } = await callJson({
      system,
      prompt,
      schema: SCORE_JSON_SCHEMA,
      schemaName: "job_fit_score",
      kind: "scoring",
    });

    const result = normalizeScore(data, { mode });
    const entry = {
      result,
      meta: meta(jobData),
      promptVersion: PROMPT_VERSION,
      fitProfileVersion: version,
      model: callMeta?.model || "",
      provider: callMeta?.provider || "",
    };

    const saved = await putCachedScore(profileId, key, entry);
    return { jobKey: key, ...saved, cached: false };
  })().finally(() => inFlight.delete(dedupeKey));

  inFlight.set(dedupeKey, work);
  return work;
}

/** Score several postings; failures are reported per item, never thrown. */
export async function scoreBatch(jobs, profileId, options) {
  return Promise.all(
    jobs.map(async (job) => {
      try {
        const scored = await scoreJob(job, profileId, options);
        return { ref: job.ref, ok: true, ...scored };
      } catch (error) {
        return { ref: job.ref, ok: false, error: error.message };
      }
    }),
  );
}

/** Look up cached scores only — never calls the API. */
export async function lookupCached(jobs, profileId) {
  const profile = await getProfile(profileId);
  if (!profile?.fitProfile) return [];
  const version = profile.fitProfileVersion || fitProfileVersion(profile.fitProfile);

  return Promise.all(
    jobs.map(async (job) => {
      const key = computeJobKey(job);
      const cached = await getCachedScore(profileId, key, version);
      return { ref: job.ref, jobKey: key, result: cached?.result || null };
    }),
  );
}

/**
 * One-time CV -> Fit Profile generation.
 *
 * `pdf` (base64) is optional. When supplied the original document is sent to
 * the model alongside (or instead of) the extracted text — that is what makes
 * scanned CVs and heavily designed multi-column layouts work, since the model
 * sees the rendered page rather than a flattened text stream.
 */
export async function generateFitProfile(cv, pdf = null) {
  const hasText = Boolean(cv && cv.trim().length >= 120);
  if (!hasText && !pdf) {
    throw new AiError("CV text looks too short — paste the full CV or attach the PDF.");
  }

  const { system, prompt } = buildFitProfilePrompt(cv, { hasDocument: Boolean(pdf) });
  const { data } = await callJson({
    system,
    prompt,
    schema: FIT_PROFILE_JSON_SCHEMA,
    schemaName: "fit_profile",
    documents: pdf ? [{ mediaType: "application/pdf", data: pdf.data, name: pdf.name }] : [],
    kind: "profile",
  });

  const fitProfile = normalizeFitProfile(data);
  return { fitProfile, fitProfileVersion: fitProfileVersion(fitProfile) };
}
