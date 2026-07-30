/**
 * PDF layout-reconstruction tests.
 *
 * Builds real PDFs, runs them through the actual pdf.js text layer, and checks
 * that reading order survives — in particular that a two-column CV is emitted
 * column-by-column rather than interleaved line-by-line.
 *
 * pdf.js is resolved from wherever pdfjs-dist is installed; if it isn't
 * available the pdf.js-dependent cases are skipped and the pure-geometry cases
 * still run.
 *
 * Run with: node tests/pdf.test.mjs
 */

import assert from "node:assert/strict";
import { toItems, reconstructPage } from "../src/shared/pdf.js";

let passed = 0;
let skipped = 0;
const t = (name, fn) => {
  try {
    fn();
    passed++;
  } catch (error) {
    console.error(`FAIL: ${name}\n  ${error.message}`);
    process.exitCode = 1;
  }
};

/* ------------------------------------------------------------------ */
/* Minimal PDF writer — enough to place text runs at exact coordinates */
/* ------------------------------------------------------------------ */

const PAGE_W = 612;
const PAGE_H = 792;

function makePdf(runs, { width = PAGE_W, height = PAGE_H } = {}) {
  const escape = (s) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const stream = runs
    .map((r) => `BT /F1 ${r.size ?? 10} Tf 1 0 0 1 ${r.x} ${r.y} Tm (${escape(r.text)}) Tj ET`)
    .join("\n");

  const objects = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Kids[3 0 R]/Count 1>>",
    `<</Type/Page/Parent 2 0 R/MediaBox[0 0 ${width} ${height}]/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>`,
    `<</Length ${Buffer.byteLength(stream)}>>\nstream\n${stream}\nendstream`,
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;

  return new Uint8Array(Buffer.from(pdf, "latin1"));
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

// A classic two-column CV: a narrow skills/contact rail on the left, the
// experience section on the right, with a clear gutter between them.
const LEFT = [
  "CONTACT",
  "alex@example.com",
  "+91 98000 00000",
  "Gurgaon, India",
  "SKILLS",
  "Competitive intelligence",
  "Win-loss analysis",
  "Executive stakeholder mgmt",
  "GenAI and automation",
  "SQL and Python",
  "Market sizing",
  "EDUCATION",
  "MBA, Strategy",
  "BSc, Life Sciences",
];

const RIGHT = [
  "EXPERIENCE",
  "Associate Consultant, Acme Health",
  "Led competitive intelligence for a top-5 pharma client.",
  "Built win-loss reporting used by the exec committee.",
  "Automated research synthesis with GenAI tooling.",
  "Analyst, Beta Research",
  "Ran market sizing across four therapy areas.",
  "Owned quarterly landscape reviews for three accounts.",
  "Presented findings to senior client stakeholders.",
  "Intern, Gamma Labs",
  "Supported primary research and data cleaning.",
  "Drafted sections of the annual outlook report.",
];

function twoColumnRuns() {
  const runs = [];
  LEFT.forEach((text, i) => runs.push({ text, x: 50, y: 730 - i * 22 }));
  RIGHT.forEach((text, i) => runs.push({ text, x: 330, y: 730 - i * 26 }));
  return runs;
}

function singleColumnRuns() {
  return [...LEFT, ...RIGHT].map((text, i) => ({ text, x: 60, y: 740 - i * 20 }));
}

/* ------------------------------------------------------------------ */
/* Geometry-only cases (no pdf.js needed)                              */
/* ------------------------------------------------------------------ */

const synthetic = (runs) =>
  runs.map((r) => ({ text: r.text, x: r.x, y: r.y, width: r.text.length * 5, height: 10 }));

t("synthetic two-column page is read column by column", () => {
  const { text, columns } = reconstructPage(synthetic(twoColumnRuns()), PAGE_W);
  assert.equal(columns, 2);
  const lastLeft = Math.max(...LEFT.map((s) => text.indexOf(s)));
  const firstRight = Math.min(...RIGHT.map((s) => text.indexOf(s)));
  assert.ok(firstRight > lastLeft, "right column must come after the whole left column");
});

t("synthetic single-column page stays single-column and in order", () => {
  const { text, columns } = reconstructPage(synthetic(singleColumnRuns()), PAGE_W);
  assert.equal(columns, 1);
  assert.ok(text.indexOf("CONTACT") < text.indexOf("EXPERIENCE"));
  assert.ok(text.indexOf("EXPERIENCE") < text.indexOf("Intern, Gamma Labs"));
});

t("a wide right margin is not mistaken for a column gutter", () => {
  // All text on the left half — the empty right side must not trigger a split.
  const runs = [...LEFT, ...RIGHT].map((text, i) => ({ text, x: 40, y: 740 - i * 20 }));
  assert.equal(reconstructPage(synthetic(runs), PAGE_W).columns, 1);
});

t("a sparse sidebar is not treated as a column", () => {
  const runs = singleColumnRuns();
  runs.push({ text: "p. 1", x: 560, y: 40 }); // page furniture only
  assert.equal(reconstructPage(synthetic(runs), PAGE_W).columns, 1);
});

t("empty input is handled", () => {
  const { text, columns } = reconstructPage([], PAGE_W);
  assert.equal(text, "");
  assert.equal(columns, 1);
});

t("items on one visual line are joined left to right", () => {
  const items = [
    { text: "Gurgaon", x: 50, y: 700, width: 40, height: 10 },
    { text: "2021-2024", x: 300, y: 700, width: 50, height: 10 },
  ];
  const { text } = reconstructPage(items, PAGE_W);
  assert.ok(/Gurgaon\s+2021-2024/.test(text), `got: ${JSON.stringify(text)}`);
  assert.ok(!text.includes("\n"), "same y should stay on one line");
});

/* ------------------------------------------------------------------ */
/* End-to-end through real pdf.js                                      */
/* ------------------------------------------------------------------ */

async function loadPdfjs() {
  for (const specifier of [
    "pdfjs-dist/legacy/build/pdf.mjs",
    process.env.PDFJS_PATH,
  ].filter(Boolean)) {
    try {
      return await import(specifier);
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

const pdfjs = await loadPdfjs();

if (!pdfjs) {
  console.log("pdfjs-dist not resolvable here — skipping end-to-end cases.");
  skipped = 2;
} else {
  const readPage = async (runs) => {
    const task = pdfjs.getDocument({
      data: makePdf(runs),
      isEvalSupported: false,
      useSystemFonts: false,
      disableFontFace: true,
      useWorkerFetch: false,
    });
    const doc = await task.promise;
    const page = await doc.getPage(1);
    const content = await page.getTextContent();
    const viewport = page.getViewport({ scale: 1 });
    const result = reconstructPage(toItems(content), viewport.width);
    await task.destroy();
    return result;
  };

  const twoCol = await readPage(twoColumnRuns());
  t("real PDF: two-column CV is not interleaved", () => {
    assert.equal(twoCol.columns, 2, "gutter should be detected");
    const lastLeft = Math.max(...LEFT.map((s) => twoCol.text.indexOf(s)));
    const firstRight = Math.min(...RIGHT.map((s) => twoCol.text.indexOf(s)));
    assert.ok(
      LEFT.every((s) => twoCol.text.includes(s)),
      "all left-column text should survive",
    );
    assert.ok(
      RIGHT.every((s) => twoCol.text.includes(s)),
      "all right-column text should survive",
    );
    assert.ok(
      firstRight > lastLeft,
      `columns interleaved:\n${twoCol.text.split("\n").slice(0, 8).join("\n")}`,
    );
  });

  const oneCol = await readPage(singleColumnRuns());
  t("real PDF: single-column CV keeps top-to-bottom order", () => {
    assert.equal(oneCol.columns, 1);
    assert.ok(oneCol.text.indexOf("CONTACT") < oneCol.text.indexOf("EXPERIENCE"));
    assert.ok(oneCol.text.indexOf("EXPERIENCE") < oneCol.text.indexOf("Intern, Gamma Labs"));
  });

  /* ---------------- the shipped extractPdfText() ---------------- */

  // pdf.js transfers its input buffer to the worker, which detaches the
  // caller's copy. The popup base64-encodes the same bytes to send the PDF to
  // the model, so extractPdfText must not consume what it is given.
  const modulePath = process.env.PDFJS_PATH ?? "pdfjs-dist/legacy/build/pdf.mjs";
  globalThis.chrome = { runtime: { getURL: () => modulePath } };
  const { extractPdfText, toBase64 } = await import("../src/shared/pdf.js");

  const bytes = makePdf(twoColumnRuns());
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const extracted = await extractPdfText(buffer);

  t("extractPdfText leaves the caller's ArrayBuffer usable", () => {
    assert.equal(buffer.byteLength > 0, true, "buffer was detached by extraction");
    // The real regression: this threw "Cannot perform Construct on a detached
    // ArrayBuffer" before extractPdfText copied its input.
    const b64 = toBase64(buffer);
    assert.ok(b64.length > 0);
    assert.ok(Buffer.from(b64, "base64").equals(Buffer.from(bytes)), "round-trip must match");
  });

  t("extractPdfText reports pages, columns and a text layer", () => {
    assert.equal(extracted.pageCount, 1);
    assert.equal(extracted.pagesRead, 1);
    assert.equal(extracted.columnPages, 1, "the two-column page should be detected");
    assert.equal(extracted.hasTextLayer, true);
    assert.ok(LEFT.every((s) => extracted.text.includes(s)));
    assert.ok(RIGHT.every((s) => extracted.text.includes(s)));
  });

  const blank = makePdf([{ text: " ", x: 50, y: 700 }]);
  const blankExtract = await extractPdfText(
    blank.buffer.slice(blank.byteOffset, blank.byteOffset + blank.byteLength),
  );
  t("a PDF with no real text is flagged as having no text layer", () =>
    assert.equal(blankExtract.hasTextLayer, false));
}

console.log(
  `\n${passed} assertions passed${skipped ? `, ${skipped} skipped` : ""}${
    process.exitCode ? " (with failures above)" : ""
  }`,
);
