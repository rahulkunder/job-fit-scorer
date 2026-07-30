/**
 * Optional per-site enablement.
 *
 * Job boards other than the three built-in ones are supported opt-in: the user
 * grants host permission for one origin, and we register the content scripts
 * dynamically. Extraction there falls back to schema.org JobPosting JSON-LD,
 * which a large share of ATS-hosted boards emit.
 */

import { getCustomSites, setCustomSites } from "../shared/storage.js";

const SCRIPT_ID_PREFIX = "jfs-site-";
const CONTENT_SCRIPTS = [
  "src/content/extractors.js",
  "src/content/widget.js",
  "src/content/listings.js",
  "src/content/main.js",
];

const scriptId = (origin) => SCRIPT_ID_PREFIX + origin.replace(/[^a-z0-9]/gi, "_");

function matchPattern(origin) {
  const { hostname } = new URL(origin);
  return `https://${hostname}/*`;
}

/**
 * Register content scripts for an already-granted origin.
 *
 * The permission itself must be requested from the popup: chrome.permissions
 * .request() requires a user gesture, and a gesture does not survive the hop
 * into the service worker.
 */
export async function enableSite(origin) {
  const pattern = matchPattern(origin);

  if (!(await chrome.permissions.contains({ origins: [pattern] }))) {
    return { ok: false, error: "Permission not granted" };
  }

  const id = scriptId(origin);
  const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [id] }).catch(() => []);
  if (!registered.length) {
    await chrome.scripting.registerContentScripts([
      { id, matches: [pattern], js: CONTENT_SCRIPTS, runAt: "document_idle" },
    ]);
  }

  const sites = await getCustomSites();
  if (!sites.includes(pattern)) await setCustomSites([...sites, pattern]);

  return { ok: true, pattern };
}

export async function disableSite(origin) {
  const pattern = matchPattern(origin);
  const id = scriptId(origin);

  await chrome.scripting.unregisterContentScripts({ ids: [id] }).catch(() => {});
  await chrome.permissions.remove({ origins: [pattern] }).catch(() => {});
  await setCustomSites((await getCustomSites()).filter((p) => p !== pattern));

  return { ok: true };
}

export async function isSiteEnabled(origin) {
  try {
    return await chrome.permissions.contains({ origins: [matchPattern(origin)] });
  } catch {
    return false;
  }
}

/**
 * Re-register dynamic scripts after an update or browser restart. Registered
 * scripts normally persist, but permissions can be revoked externally — drop
 * any site we no longer hold permission for.
 */
export async function restoreSites() {
  const sites = await getCustomSites();
  if (!sites.length) return;

  const existing = await chrome.scripting.getRegisteredContentScripts().catch(() => []);
  const existingIds = new Set(existing.map((s) => s.id));
  const surviving = [];

  for (const pattern of sites) {
    const origin = `https://${new URL(pattern.replace(/\*$/, "")).hostname}`;
    if (!(await isSiteEnabled(origin))) continue;
    surviving.push(pattern);

    const id = scriptId(origin);
    if (existingIds.has(id)) continue;
    await chrome.scripting
      .registerContentScripts([{ id, matches: [pattern], js: CONTENT_SCRIPTS, runAt: "document_idle" }])
      .catch(() => {});
  }

  if (surviving.length !== sites.length) await setCustomSites(surviving);
}
