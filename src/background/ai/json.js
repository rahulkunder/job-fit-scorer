/**
 * Extract a JSON object from model output.
 *
 * Constrained decoding is requested from every provider, but it is not
 * guaranteed on every model/provider combination — a model can still wrap the
 * object in ```json fences or prose. This scanner finds the first balanced
 * top-level object while respecting string literals and escapes, so a `{` or
 * `}` inside a quoted value doesn't terminate the scan early.
 */

function stripFences(text) {
  return text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
}

/** Index range of the first balanced {...} outside of string literals. */
function findObject(text) {
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }

    if (ch === '"') inString = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Last-resort repairs for near-miss JSON. */
function repair(candidate) {
  return candidate
    .replace(/,\s*([}\]])/g, "$1") // trailing commas
    .replace(/[“”]/g, '"') // smart double quotes
    .replace(/[‘’]/g, "'");
}

export function parseJsonObject(text) {
  if (typeof text !== "string" || !text.trim()) {
    throw new Error("Model returned an empty response");
  }

  const cleaned = stripFences(text.trim());

  try {
    const direct = JSON.parse(cleaned);
    if (direct && typeof direct === "object") return direct;
  } catch {
    /* fall through to scanning */
  }

  const candidate = findObject(cleaned);
  if (!candidate) {
    throw new Error(`Model returned no JSON object: ${cleaned.slice(0, 160)}`);
  }

  try {
    return JSON.parse(candidate);
  } catch {
    return JSON.parse(repair(candidate));
  }
}
