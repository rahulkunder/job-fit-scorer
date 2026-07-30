/** RFC 4180 CSV serialisation for history export. */

function cell(value) {
  const s = value === null || value === undefined ? "" : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows, columns) {
  const header = columns.map((c) => cell(c.label)).join(",");
  const body = rows.map((row) => columns.map((c) => cell(c.get(row))).join(","));
  // Leading BOM so Excel opens UTF-8 correctly.
  return `﻿${[header, ...body].join("\r\n")}\r\n`;
}

export const HISTORY_COLUMNS = [
  { label: "Scored at", get: (r) => new Date(r.savedAt || 0).toISOString() },
  { label: "Title", get: (r) => r.meta?.title },
  { label: "Company", get: (r) => r.meta?.company },
  { label: "Location", get: (r) => r.meta?.location },
  { label: "Site", get: (r) => r.meta?.site },
  { label: "Score", get: (r) => r.result?.overallScore },
  { label: "Category", get: (r) => r.result?.roleCategory },
  { label: "Maps to", get: (r) => r.result?.matchType },
  { label: "Recommendation", get: (r) => r.result?.recommendation },
  { label: "Skills /40", get: (r) => r.result?.breakdown?.skillsMatch },
  { label: "Experience /25", get: (r) => r.result?.breakdown?.experienceFit },
  { label: "Role /20", get: (r) => r.result?.breakdown?.roleAlignment },
  { label: "Location /15", get: (r) => r.result?.breakdown?.locationFit },
  { label: "Why it fits", get: (r) => r.result?.whyFits },
  { label: "Gaps", get: (r) => r.result?.gaps },
  { label: "Stretch", get: (r) => r.result?.growthStretch },
  { label: "Salary", get: (r) => r.result?.salaryFitFlag },
  { label: "Mode", get: (r) => r.result?.mode },
  { label: "Status", get: (r) => r.status || "" },
  { label: "Notes", get: (r) => r.notes || "" },
  { label: "URL", get: (r) => r.meta?.url },
];
