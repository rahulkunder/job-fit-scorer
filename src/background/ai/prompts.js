/**
 * Prompt construction.
 *
 * The whole cost model of the extension rests on one idea: the CV is read once
 * to build a compact Fit Profile, and every subsequent job scan sends only that
 * profile plus the job description. Keep these prompts small — they run on
 * every job page view.
 *
 * Bump PROMPT_VERSION in constants.js after any semantic edit here, otherwise
 * cached scores from the old prompt keep being served.
 */

import { CATEGORIES, MAX_CV_CHARS, MAX_JD_CHARS, WEIGHTS } from "../../shared/constants.js";

const SCORER_SYSTEM = `You are a rigorous job-fit analyst.

You evaluate a job posting against a candidate's structured Fit Profile and return a calibrated score.

Rules:
- Consider primaryRoles, adjacentRoles AND growthRoles. A job that is not the candidate's current job title can still be an excellent fit through transferable skills — score it on substance, not title-matching.
- Never penalise a role purely for a different industry when the underlying skill transfers. Say so explicitly in whyFits.
- Be honest about gaps. Inflated scores make the tool useless.
- If the posting hits a dealBreaker, cap the score at 3 and set recommendation to "Skip".
- If the job description is thin or truncated, score what is there and note the uncertainty in gaps.

Score out of 100 across four criteria, then report each sub-score:
- skillsMatch (0-${WEIGHTS.skillsMatch})
- experienceFit (0-${WEIGHTS.experienceFit}) — under-qualified and heavily over-qualified both lose points
- roleAlignment (0-${WEIGHTS.roleAlignment}) — against the full fit space, not just primaryRoles
- locationFit (0-${WEIGHTS.locationFit}) — remote counts as a match for any stated preference; award full marks when location is unknown rather than guessing

overallScore is that total divided by 10, on a 0-10 scale.

roleCategory must be one of: ${CATEGORIES.map((c) => `"${c}"`).join(", ")}.
- "Primary Fit": core to the candidate's current expertise
- "Adjacent Fit": transferable skills, slightly new context
- "Growth Stretch": reachable with minor upskilling
- "Reach": possible but a significant gap
- "Poor Fit": skip it

Keep whyFits and gaps to two short sentences each. Write for the candidate, in plain language.

Respond with a single JSON object and nothing else — no prose, no markdown fences. Keys: overallScore (0-10), roleCategory, matchType, breakdown {skillsMatch, experienceFit, roleAlignment, locationFit}, whyFits, gaps, growthStretch, recommendation ("Apply" | "Maybe" | "Skip"), salaryFitFlag ("In range" | "Below" | "Above" | "Unknown").`;

const QUICK_SUFFIX = `

IMPORTANT: you are scoring from a search-results snippet, not a full job description. Judge only what is present, keep the score conservative, and state in gaps that this is a preliminary read from limited information.`;

const PROFILE_SYSTEM = `You are a career analyst who maps a CV to the full space of roles a candidate could realistically win — not just their current title.

Read the CV and produce a structured Fit Profile:
- primaryRoles: roles that match their current expertise directly.
- adjacentRoles: roles reachable now via transferable skills, deliberately including other industries and functions. Be generous and specific here — this field is what lets the tool surface non-obvious opportunities.
- growthRoles: roles reachable with minor upskilling (6-12 months).
- transferableSkills: short statements explaining WHY a skill carries across contexts.
- dealBreakers: only what the CV genuinely implies (e.g. a research profile is a poor fit for pure sales). Do not invent constraints.
- locationPrefs / targetCTC: only if stated or clearly implied; otherwise leave empty.

Think broadly across industries. Prefer concrete job titles a recruiter would actually post.

Respond with a single JSON object and nothing else — no prose, no markdown fences. Keys: candidateName, experienceYears (number), experienceBand, primaryDomain, coreSkills[], primaryRoles[], adjacentRoles[], growthRoles[], transferableSkills[], locationPrefs[], targetCTC, dealBreakers[].`;

function truncate(text, limit) {
  const s = String(text || "").replace(/\s+\n/g, "\n").trim();
  return s.length > limit ? `${s.slice(0, limit)}\n…[truncated]` : s;
}

/** Compact the fit profile for the wire — omit empty fields. */
function compactProfile(fitProfile) {
  const out = {};
  for (const [key, value] of Object.entries(fitProfile || {})) {
    const empty = value === "" || value === null || value === undefined || (Array.isArray(value) && !value.length);
    if (!empty) out[key] = value;
  }
  return JSON.stringify(out);
}

export function buildScoringPrompt(fitProfile, jobData, mode = "full") {
  const parts = [
    "CANDIDATE FIT PROFILE:",
    compactProfile(fitProfile),
    "",
    "JOB POSTING:",
    `Title: ${jobData.title || "(unknown)"}`,
    `Company: ${jobData.company || "(unknown)"}`,
    `Location: ${jobData.location || "(unknown)"}`,
  ];
  if (jobData.salary) parts.push(`Salary: ${jobData.salary}`);
  parts.push("", "Description:", truncate(jobData.description, MAX_JD_CHARS));

  return {
    system: mode === "quick" ? SCORER_SYSTEM + QUICK_SUFFIX : SCORER_SYSTEM,
    prompt: parts.join("\n"),
  };
}

export function buildFitProfilePrompt(cv, { hasDocument = false } = {}) {
  const text = truncate(cv, MAX_CV_CHARS);

  if (hasDocument) {
    return {
      system: PROFILE_SYSTEM,
      prompt: text
        ? // Both are supplied when the PDF has a text layer but a layout we may
          // have flattened badly; the document is authoritative for ordering.
          `The candidate's CV is attached as a PDF. A local text extraction is included below as a fallback — where the two disagree, trust the PDF, since the extraction can scramble multi-column layouts.\n\nEXTRACTED TEXT:\n${text}`
        : "The candidate's CV is attached as a PDF. Read it and produce the Fit Profile.",
    };
  }

  return { system: PROFILE_SYSTEM, prompt: `CV:\n${text}` };
}
