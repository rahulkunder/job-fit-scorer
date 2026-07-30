/**
 * Stable identity for a job posting, used as the dedup/cache key.
 *
 * Preference order:
 *   1. site + canonical job id parsed from the URL (most stable — survives
 *      A/B copy changes, description truncation and re-crawls)
 *   2. content hash of title|company|location|description-prefix
 *
 * The hash is FNV-1a (32-bit) rendered in base36. It is not cryptographic;
 * it only needs to be stable and collision-resistant enough for a few hundred
 * entries per profile.
 */

export function hash(input) {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function jobKey(jobData) {
  if (jobData.site && jobData.jobId) {
    return `${jobData.site}:${jobData.jobId}`;
  }
  const fingerprint = [
    normalize(jobData.title),
    normalize(jobData.company),
    normalize(jobData.location),
    normalize(jobData.description).slice(0, 400),
  ].join("|");
  return `h:${hash(fingerprint)}`;
}

/** Identity of a fit profile — changing the CV invalidates cached scores. */
export function fitProfileVersion(fitProfile) {
  if (!fitProfile) return null;
  return hash(JSON.stringify(fitProfile));
}
