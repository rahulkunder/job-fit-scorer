/**
 * Logic tests for the pure modules (no chrome APIs involved).
 * Run with: node tests/logic.test.mjs
 */
import assert from "node:assert/strict";
import { parseJsonObject } from "../src/background/ai/json.js";
import { normalizeScore, normalizeFitProfile } from "../src/shared/schema.js";
import { jobKey, fitProfileVersion, hash } from "../src/shared/jobkey.js";
import { Limiter } from "../src/background/ai/limiter.js";
import { toCsv, HISTORY_COLUMNS } from "../src/shared/csv.js";
import { buildScoringPrompt, buildFitProfilePrompt } from "../src/background/ai/prompts.js";
import { pickBestModel, DEFAULT_SETTINGS, SETTINGS_VERSION } from "../src/shared/constants.js";
import { migrateSettings } from "../src/shared/storage.js";

let passed = 0;
const t = (name, fn) => {
  try {
    fn();
    passed++;
  } catch (e) {
    console.error(`FAIL: ${name}\n  ${e.message}`);
    process.exitCode = 1;
  }
};

/* ---------------- json.js ---------------- */

t("parses plain JSON", () => assert.equal(parseJsonObject('{"a":1}').a, 1));

t("strips ```json fences", () =>
  assert.equal(parseJsonObject('```json\n{"a":2}\n```').a, 2));

t("extracts object from surrounding prose", () =>
  assert.equal(parseJsonObject('Sure! Here you go:\n{"a":3}\nHope that helps.').a, 3));

t("does not terminate on braces inside strings", () => {
  const out = parseJsonObject('prefix {"whyFits":"uses } and { chars","n":4} suffix');
  assert.equal(out.n, 4);
  assert.equal(out.whyFits, "uses } and { chars");
});

t("handles escaped quotes inside strings", () => {
  const out = parseJsonObject('{"s":"he said \\"hi\\" }","n":5}');
  assert.equal(out.n, 5);
});

t("repairs trailing commas", () =>
  assert.equal(parseJsonObject('{"a":6,}').a, 6));

t("repairs smart quotes", () =>
  assert.equal(parseJsonObject('{“a”:7}').a, 7));

t("throws on empty input", () =>
  assert.throws(() => parseJsonObject("   "), /empty/i));

t("throws when no object present", () =>
  assert.throws(() => parseJsonObject("I cannot help with that."), /no JSON/i));

/* ---------------- schema.js ---------------- */

t("derives overall score from the rubric breakdown", () => {
  const r = normalizeScore({
    overallScore: 9,
    breakdown: { skillsMatch: 30, experienceFit: 20, roleAlignment: 10, locationFit: 10 },
    roleCategory: "adjacent",
    recommendation: "apply",
  });
  assert.equal(r.overallScore, 7); // 70/10, not the model's 9
  assert.equal(r.modelScore, 9);
  assert.equal(r.scoreDerived, true);
  assert.equal(r.roleCategory, "Adjacent Fit");
  assert.equal(r.recommendation, "Apply");
});

t("falls back to the model score when the breakdown is incomplete", () => {
  const r = normalizeScore({ overallScore: 6.4, breakdown: { skillsMatch: 30 } });
  assert.equal(r.overallScore, 6.4);
  assert.equal(r.scoreDerived, false);
});

t("clamps out-of-range sub-scores", () => {
  const r = normalizeScore({
    breakdown: { skillsMatch: 999, experienceFit: -5, roleAlignment: 20, locationFit: 15 },
  });
  assert.equal(r.breakdown.skillsMatch, 40);
  assert.equal(r.breakdown.experienceFit, 0);
  assert.equal(r.overallScore, 7.5);
});

t("snaps unknown categories to Poor Fit", () =>
  assert.equal(normalizeScore({ roleCategory: "banana" }).roleCategory, "Poor Fit"));

t("survives garbage input", () => {
  const r = normalizeScore(null);
  assert.equal(r.overallScore, 0);
  assert.equal(r.recommendation, "Maybe");
  assert.equal(r.salaryFitFlag, "Unknown");
});

t("truncates over-long strings", () => {
  const r = normalizeScore({ whyFits: "x".repeat(5000) });
  assert.ok(r.whyFits.length <= 400);
});

t("coerces string lists on the fit profile", () => {
  const p = normalizeFitProfile({ coreSkills: "research, synthesis, GenAI", experienceYears: "2.2" });
  assert.deepEqual(p.coreSkills, ["research", "synthesis", "GenAI"]);
  assert.equal(p.experienceYears, 2.2);
});

/* ---------------- jobkey.js ---------------- */

t("prefers site + job id", () =>
  assert.equal(jobKey({ site: "linkedin", jobId: "412", title: "X" }), "linkedin:412"));

t("hashes content when no id is available", () => {
  const a = jobKey({ title: "Analyst", company: "Acme", location: "Delhi", description: "abc" });
  const b = jobKey({ title: "ANALYST ", company: "acme", location: "delhi", description: "abc" });
  assert.equal(a, b, "normalisation should make these identical");
  assert.ok(a.startsWith("h:"));
});

t("different jobs get different keys", () => {
  const a = jobKey({ title: "Analyst", description: "one" });
  const b = jobKey({ title: "Analyst", description: "two" });
  assert.notEqual(a, b);
});

t("fit profile version changes with content", () => {
  assert.notEqual(fitProfileVersion({ a: 1 }), fitProfileVersion({ a: 2 }));
  assert.equal(fitProfileVersion(null), null);
});

t("hash is stable and non-empty", () => {
  assert.equal(hash("abc"), hash("abc"));
  assert.ok(hash("abc").length > 0);
});

/* ---------------- limiter.js ---------------- */

const limiterTest = (async () => {
  const limiter = new Limiter({ rpm: 600, concurrency: 2 });
  let active = 0;
  let peak = 0;
  const task = () =>
    new Promise((resolve) => {
      active++;
      peak = Math.max(peak, active);
      setTimeout(() => {
        active--;
        resolve("ok");
      }, 20);
    });

  const results = await Promise.all(Array.from({ length: 8 }, () => limiter.run(task)));
  assert.equal(results.length, 8);
  assert.ok(peak <= 2, `concurrency cap exceeded: peak=${peak}`);

  // Rejections propagate and do not wedge the queue.
  await assert.rejects(limiter.run(() => Promise.reject(new Error("boom"))), /boom/);
  assert.equal(await limiter.run(() => "still working"), "still working");
  passed += 2;
})();

/* ---------------- csv.js ---------------- */

t("escapes quotes, commas and newlines", () => {
  const csv = toCsv(
    [{ result: { whyFits: 'He said "yes", then\nleft' }, meta: { title: "A,B" }, savedAt: 0 }],
    HISTORY_COLUMNS,
  );
  assert.ok(csv.includes('"He said ""yes"", then\nleft"'));
  assert.ok(csv.includes('"A,B"'));
  assert.ok(csv.startsWith("﻿"));
});

/* ---------------- prompts.js ---------------- */

t("scoring prompt omits empty profile fields and truncates the JD", () => {
  const { system, prompt } = buildScoringPrompt(
    { primaryRoles: ["Analyst"], adjacentRoles: [], targetCTC: "" },
    { title: "T", company: "C", location: "L", description: "y".repeat(20000) },
  );
  assert.ok(!prompt.includes("adjacentRoles"), "empty arrays should be dropped");
  assert.ok(!prompt.includes("targetCTC"));
  assert.ok(prompt.includes("[truncated]"));
  assert.ok(prompt.length < 8000);
  assert.ok(system.includes("Adjacent Fit"));
});

t("quick mode adds the low-confidence instruction", () => {
  const { system } = buildScoringPrompt({}, { title: "T", description: "d" }, "quick");
  assert.ok(system.includes("search-results snippet"));
});

t("fit-profile prompt truncates the CV", () => {
  const { prompt } = buildFitProfilePrompt("z".repeat(50000));
  assert.ok(prompt.includes("[truncated]"));
});

/* ---------------- model auto-selection ---------------- */

t("picks the newest flash-tier Gemini model", () =>
  assert.equal(
    pickBestModel("gemini", [
      "gemini-2.5-flash",
      "gemini-3.6-flash",
      "gemini-3.5-flash-lite",
      "gemini-2.5-pro",
      "gemini-3-flash-preview",
    ]),
    "gemini-3.6-flash",
  ));

t("falls back to an older model when the newest is absent", () =>
  assert.equal(pickBestModel("gemini", ["gemini-2.5-flash", "gemini-2.5-pro"]), "gemini-2.5-flash"));

t("excludes non-text Gemini models", () =>
  assert.equal(pickBestModel("gemini", ["text-embedding-004", "imagen-3.0", "veo-2"]), null));

t("prefers a stable Claude alias over a dated snapshot", () =>
  assert.equal(
    pickBestModel("claude", [
      "claude-opus-5",
      "claude-haiku-4-5-20251001",
      "claude-sonnet-5",
      "claude-haiku-4-5",
    ]),
    "claude-haiku-4-5",
  ));

t("steps up the Claude tier when no haiku is offered", () =>
  assert.equal(pickBestModel("claude", ["claude-opus-5", "claude-sonnet-5"]), "claude-sonnet-5"));

t("prefers the newest mini model on OpenAI and skips non-chat models", () =>
  assert.equal(
    pickBestModel("openai", [
      "gpt-4o",
      "gpt-4o-mini",
      "text-embedding-3-small",
      "dall-e-3",
      "gpt-4.1-mini",
      "whisper-1",
    ]),
    "gpt-4.1-mini",
  ));

t("returns null for an empty or unknown provider", () => {
  assert.equal(pickBestModel("gemini", []), null);
  assert.equal(pickBestModel("nope", ["x"]), null);
});

/* ---------------- settings migration ---------------- */

t("raises the v1 token ceiling that could starve the answer", () => {
  const out = migrateSettings({ maxOutputTokens: 2000, apiKey: "k" });
  assert.equal(out.maxOutputTokens, DEFAULT_SETTINGS.maxOutputTokens);
  assert.equal(out.apiKey, "k", "unrelated settings must survive");
  assert.equal(out.settingsVersion, SETTINGS_VERSION);
});

t("leaves a deliberately raised budget alone", () =>
  assert.equal(migrateSettings({ maxOutputTokens: 8000 }).maxOutputTokens, 8000));

t("migration is idempotent", () => {
  const once = migrateSettings({ maxOutputTokens: 2000 });
  assert.deepEqual(migrateSettings(once), once);
});

t("migrating an empty blob yields just the version", () =>
  assert.equal(migrateSettings().settingsVersion, SETTINGS_VERSION));

await limiterTest;
console.log(`\n${passed} assertions passed${process.exitCode ? " (with failures above)" : ""}`);
