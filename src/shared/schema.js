/**
 * Normalisation for model output.
 *
 * Structured outputs are requested from every provider, but no model output is
 * trusted: scores get clamped, categories snapped to the allowed set, and
 * strings coerced + length-capped. The rest of the extension can then treat a
 * result as well-formed without defensive checks at every render site.
 */

import { CATEGORIES, RECOMMENDATIONS, SALARY_FLAGS, WEIGHTS } from "./constants.js";

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function num(value, lo, hi, fallback = 0) {
  const n = typeof value === "number" ? value : parseFloat(value);
  return Number.isFinite(n) ? clamp(n, lo, hi) : fallback;
}

function str(value, maxLen = 400) {
  if (value === null || value === undefined) return "";
  const s = String(Array.isArray(value) ? value.join(", ") : value).trim();
  return s.length > maxLen ? `${s.slice(0, maxLen - 1)}…` : s;
}

function strList(value, maxItems = 20, maxLen = 120) {
  const arr = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[,;\n]/) : [];
  return arr
    .map((v) => str(v, maxLen))
    .filter(Boolean)
    .slice(0, maxItems);
}

/** Snap a free-text category to the closest allowed value. */
function snapCategory(value) {
  const raw = str(value, 60).toLowerCase();
  const exact = CATEGORIES.find((c) => c.toLowerCase() === raw);
  if (exact) return exact;
  if (raw.includes("primary") || raw.includes("core") || raw.includes("strong")) return "Primary Fit";
  if (raw.includes("adjacent") || raw.includes("transfer")) return "Adjacent Fit";
  if (raw.includes("growth") || raw.includes("stretch")) return "Growth Stretch";
  if (raw.includes("reach")) return "Reach";
  return "Poor Fit";
}

function snapEnum(value, allowed, fallback) {
  const raw = str(value, 40).toLowerCase();
  return allowed.find((a) => a.toLowerCase() === raw) || fallback;
}

/**
 * Normalise a scoring result.
 *
 * When the model returns a complete breakdown we derive `overallScore` from it
 * rather than trusting the model's own headline number — the rubric weights are
 * the contract, and models routinely return a breakdown that sums to something
 * other than the score they wrote. The model's number is kept as `modelScore`
 * so a mismatch stays visible rather than being silently overwritten.
 */
export function normalizeScore(raw, { mode = "full" } = {}) {
  const source = raw && typeof raw === "object" ? raw : {};
  const rawBreakdown = source.breakdown && typeof source.breakdown === "object" ? source.breakdown : {};

  const breakdown = {
    skillsMatch: num(rawBreakdown.skillsMatch, 0, WEIGHTS.skillsMatch),
    experienceFit: num(rawBreakdown.experienceFit, 0, WEIGHTS.experienceFit),
    roleAlignment: num(rawBreakdown.roleAlignment, 0, WEIGHTS.roleAlignment),
    locationFit: num(rawBreakdown.locationFit, 0, WEIGHTS.locationFit),
  };

  const hasBreakdown = Object.keys(WEIGHTS).every((k) => Number.isFinite(rawBreakdown[k]));
  const derived = Object.values(breakdown).reduce((a, b) => a + b, 0) / 10;
  const modelScore = num(source.overallScore, 0, 10, derived);
  const overallScore = Math.round((hasBreakdown ? derived : modelScore) * 10) / 10;

  return {
    overallScore,
    modelScore: Math.round(modelScore * 10) / 10,
    scoreDerived: hasBreakdown,
    roleCategory: snapCategory(source.roleCategory),
    matchType: str(source.matchType, 120),
    breakdown,
    whyFits: str(source.whyFits, 400),
    gaps: str(source.gaps, 400),
    growthStretch: str(source.growthStretch, 240),
    recommendation: snapEnum(source.recommendation, RECOMMENDATIONS, "Maybe"),
    salaryFitFlag: snapEnum(source.salaryFitFlag, SALARY_FLAGS, "Unknown"),
    mode,
  };
}

/** Normalise a generated fit profile. */
export function normalizeFitProfile(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    candidateName: str(source.candidateName, 80),
    experienceYears: num(source.experienceYears, 0, 60, 0),
    experienceBand: str(source.experienceBand, 80),
    primaryDomain: str(source.primaryDomain, 120),
    coreSkills: strList(source.coreSkills, 25),
    primaryRoles: strList(source.primaryRoles, 12),
    adjacentRoles: strList(source.adjacentRoles, 15),
    growthRoles: strList(source.growthRoles, 12),
    transferableSkills: strList(source.transferableSkills, 12, 200),
    locationPrefs: strList(source.locationPrefs, 12),
    targetCTC: str(source.targetCTC, 60),
    dealBreakers: strList(source.dealBreakers, 12),
  };
}

/** JSON Schema handed to providers that support constrained decoding. */
export const SCORE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    overallScore: { type: "number", description: "0-10 overall fit" },
    roleCategory: { type: "string", enum: CATEGORIES },
    matchType: { type: "string", description: "Which role from the fit profile this maps to" },
    breakdown: {
      type: "object",
      additionalProperties: false,
      properties: {
        skillsMatch: { type: "number", description: "0-40" },
        experienceFit: { type: "number", description: "0-25" },
        roleAlignment: { type: "number", description: "0-20" },
        locationFit: { type: "number", description: "0-15" },
      },
      required: ["skillsMatch", "experienceFit", "roleAlignment", "locationFit"],
    },
    whyFits: { type: "string" },
    gaps: { type: "string" },
    growthStretch: { type: "string" },
    recommendation: { type: "string", enum: RECOMMENDATIONS },
    salaryFitFlag: { type: "string", enum: SALARY_FLAGS },
  },
  required: [
    "overallScore",
    "roleCategory",
    "matchType",
    "breakdown",
    "whyFits",
    "gaps",
    "growthStretch",
    "recommendation",
    "salaryFitFlag",
  ],
};

export const FIT_PROFILE_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    candidateName: { type: "string" },
    experienceYears: { type: "number" },
    experienceBand: { type: "string" },
    primaryDomain: { type: "string" },
    coreSkills: { type: "array", items: { type: "string" } },
    primaryRoles: { type: "array", items: { type: "string" } },
    adjacentRoles: { type: "array", items: { type: "string" } },
    growthRoles: { type: "array", items: { type: "string" } },
    transferableSkills: { type: "array", items: { type: "string" } },
    locationPrefs: { type: "array", items: { type: "string" } },
    targetCTC: { type: "string" },
    dealBreakers: { type: "array", items: { type: "string" } },
  },
  required: [
    "candidateName",
    "experienceYears",
    "experienceBand",
    "primaryDomain",
    "coreSkills",
    "primaryRoles",
    "adjacentRoles",
    "growthRoles",
    "transferableSkills",
    "locationPrefs",
    "targetCTC",
    "dealBreakers",
  ],
};
