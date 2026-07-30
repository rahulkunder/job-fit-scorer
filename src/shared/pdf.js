/**
 * PDF → plain text, entirely on-device (pdf.js, vendored under src/vendor).
 *
 * The hard part for CVs is not decoding the PDF — it is reconstructing reading
 * order. A large share of CVs are two-column (skills/contact rail on one side,
 * experience on the other), and a naive extraction interleaves the columns line
 * by line, producing text that reads as nonsense to the model. Since the Fit
 * Profile is generated once and everything downstream depends on it, that
 * failure is expensive and silent.
 *
 * So this module: detects a vertical gutter, reads columns in order, rebuilds
 * lines and paragraphs from glyph positions, and reports whether the document
 * actually had a text layer at all (scanned CVs have none).
 */

/** pdf.js is ~500 KB — only parse it when a PDF is actually opened. */
let pdfjsPromise = null;

async function loadPdfjs() {
  pdfjsPromise ||= (async () => {
    const pdfjs = await import(chrome.runtime.getURL("src/vendor/pdfjs/pdf.min.mjs"));
    pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL(
      "src/vendor/pdfjs/pdf.worker.min.mjs",
    );
    return pdfjs;
  })();
  return pdfjsPromise;
}

/* ------------------------------------------------------------------ */
/* Layout reconstruction                                               */
/* ------------------------------------------------------------------ */

const BINS = 120;
/** A gutter must be this fraction of page width to count as a column split. */
const MIN_GUTTER_RATIO = 0.045;
/** …and must sit within this middle band of the page. */
const GUTTER_BAND = [0.22, 0.78];
/** Each column needs at least this share of the page's glyphs to be believed. */
const MIN_COLUMN_SHARE = 0.15;

export function toItems(textContent) {
  const items = [];
  for (const item of textContent.items) {
    if (typeof item.str !== "string" || !item.str.trim()) continue;
    const [, , , scaleY, x, y] = item.transform;
    items.push({
      text: item.str,
      x,
      y,
      width: item.width || 0,
      height: Math.abs(scaleY) || item.height || 10,
    });
  }
  return items;
}

/**
 * Find a vertical gutter: a horizontal band, in the middle of the page, that no
 * glyph crosses. Returns the x coordinate to split on, or null.
 */
function findGutter(items, pageWidth) {
  // Below this there isn't enough evidence to call a gap a column break. A
  // one-page CV typically yields 25-80 runs, so the floor is deliberately low;
  // MIN_COLUMN_SHARE is what actually rejects margins and page furniture.
  if (items.length < 16 || pageWidth <= 0) return null;

  const occupied = new Uint8Array(BINS);
  const binOf = (x) => Math.max(0, Math.min(BINS - 1, Math.floor((x / pageWidth) * BINS)));

  for (const item of items) {
    const from = binOf(item.x);
    const to = binOf(item.x + item.width);
    for (let b = from; b <= to; b++) occupied[b] = 1;
  }

  const lo = Math.floor(BINS * GUTTER_BAND[0]);
  const hi = Math.ceil(BINS * GUTTER_BAND[1]);
  const minRun = Math.max(2, Math.round(BINS * MIN_GUTTER_RATIO));

  let best = null;
  let runStart = -1;
  for (let b = lo; b <= hi; b++) {
    if (!occupied[b]) {
      if (runStart < 0) runStart = b;
    } else {
      if (runStart >= 0 && b - runStart >= minRun && (!best || b - runStart > best.length)) {
        best = { start: runStart, length: b - runStart };
      }
      runStart = -1;
    }
  }
  if (runStart >= 0 && hi - runStart >= minRun && (!best || hi - runStart > best.length)) {
    best = { start: runStart, length: hi - runStart };
  }
  if (!best) return null;

  const splitX = ((best.start + best.length / 2) / BINS) * pageWidth;
  const left = items.filter((i) => i.x + i.width / 2 < splitX).length;
  const right = items.length - left;

  // A gutter with almost nothing on one side is a margin, not a column break.
  const share = Math.min(left, right) / items.length;
  return share >= MIN_COLUMN_SHARE ? splitX : null;
}

/** Group positioned glyph runs into lines and paragraphs, top-to-bottom. */
function itemsToText(items) {
  if (!items.length) return "";

  // PDF y grows upward, so descending y is descending reading order.
  const sorted = [...items].sort((a, b) => (Math.abs(a.y - b.y) > 2 ? b.y - a.y : a.x - b.x));

  const lines = [];
  let current = null;

  for (const item of sorted) {
    const tolerance = Math.max(2, item.height * 0.5);
    if (current && Math.abs(current.y - item.y) <= tolerance) {
      current.items.push(item);
      current.y = (current.y * (current.items.length - 1) + item.y) / current.items.length;
    } else {
      current = { y: item.y, height: item.height, items: [item] };
      lines.push(current);
    }
  }

  const out = [];
  let previous = null;

  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);

    let text = "";
    let cursor = null;
    for (const item of line.items) {
      if (cursor !== null) {
        const gap = item.x - cursor;
        // A gap wider than roughly a space means a real word boundary; a wide
        // one means separate fields on the same visual line.
        if (gap > item.height * 0.9) text += "   ";
        else if (gap > item.height * 0.18 && !/\s$/.test(text)) text += " ";
      }
      text += item.text;
      cursor = item.x + item.width;
    }

    text = text.replace(/[ \t]+/g, " ").trim();
    if (!text) continue;

    // A vertical jump much larger than the line height is a paragraph break.
    if (previous) {
      const gap = previous.y - line.y;
      if (gap > Math.max(previous.height, line.height) * 1.7) out.push("");
    }
    out.push(text);
    previous = line;
  }

  return out.join("\n");
}

/**
 * Rebuild one page's reading order from positioned glyph runs.
 * Exported so tests can exercise it without a browser or a real PDF pipeline.
 *
 * @param {{text,x,y,width,height}[]} items
 * @param {number} pageWidth
 */
export function reconstructPage(items, pageWidth) {
  const splitX = findGutter(items, pageWidth);
  if (splitX === null) return { text: itemsToText(items), columns: 1 };

  const left = items.filter((i) => i.x + i.width / 2 < splitX);
  const right = items.filter((i) => i.x + i.width / 2 >= splitX);
  return {
    text: [itemsToText(left), itemsToText(right)].filter(Boolean).join("\n\n"),
    columns: 2,
  };
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

export class PdfError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "PdfError";
    this.code = code;
  }
}

/**
 * @param {ArrayBuffer} buffer
 * @returns {Promise<{text, pageCount, pagesRead, columnPages, hasTextLayer}>}
 */
export async function extractPdfText(buffer, { maxPages = 20 } = {}) {
  const pdfjs = await loadPdfjs();

  // Teardown lives on the loading task — PDFDocumentProxy has no destroy().
  const task = pdfjs.getDocument({
    // pdf.js *transfers* this buffer to its worker, which detaches the
    // original. Hand it a copy so the caller can still use theirs afterwards
    // (the popup base64-encodes the same bytes to send the PDF to the model).
    data: new Uint8Array(buffer.slice(0)),
    // MV3 forbids eval; disable the optional code paths that would want it.
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    // Nothing here renders, so never fetch optional standard-font assets.
    useWorkerFetch: false,
  });

  let doc;
  try {
    doc = await task.promise;
  } catch (error) {
    await task.destroy().catch(() => {});
    if (error?.name === "PasswordException") {
      throw new PdfError("This PDF is password-protected. Remove the password and try again.", "password");
    }
    throw new PdfError(`Could not read this PDF: ${error.message}`, "parse");
  }

  try {
    const pagesRead = Math.min(doc.numPages, maxPages);
    const chunks = [];
    let columnPages = 0;

    for (let n = 1; n <= pagesRead; n++) {
      const page = await doc.getPage(n);
      try {
        const [content, viewport] = await Promise.all([
          page.getTextContent(),
          Promise.resolve(page.getViewport({ scale: 1 })),
        ]);
        const { text, columns } = reconstructPage(toItems(content), viewport.width);
        if (columns === 2) columnPages++;
        if (text.trim()) chunks.push(text);
      } finally {
        page.cleanup();
      }
    }

    const text = chunks.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();

    return {
      text,
      pageCount: doc.numPages,
      pagesRead,
      columnPages,
      // A scanned CV parses fine and yields almost nothing — that is a
      // different failure from a broken file and needs a different message.
      hasTextLayer: text.replace(/\s/g, "").length >= 200,
    };
  } finally {
    await task.destroy().catch(() => {});
  }
}

/** Base64 for native-PDF passthrough to the model. */
export function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  // Chunked to stay well under the argument-count limit on large files.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}
