/**
 * Popup controller.
 *
 * All persistence goes through the background worker rather than touching
 * chrome.storage here: the worker owns the write locks, and routing every
 * mutation through one writer is what keeps concurrent popup/tab activity from
 * clobbering each other.
 */

import { PROVIDERS } from "../shared/constants.js";
import { extractPdfText, toBase64, PdfError } from "../shared/pdf.js";

const $ = (id) => document.getElementById(id);

function send(action, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action, ...payload }, (response) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!response) return reject(new Error("No response from extension"));
      if (!response.ok) return reject(new Error(response.error || "Request failed"));
      resolve(response.data);
    });
  });
}

function setStatus(node, message, kind = "") {
  node.textContent = message ?? "";
  node.className = `status ${kind}`.trim();
}

/** Run an async action with a busy/done/error status and a disabled button. */
async function withStatus(button, statusNode, busyText, action, doneText) {
  const label = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = busyText;
  }
  setStatus(statusNode, busyText, "busy");
  try {
    const result = await action();
    setStatus(statusNode, typeof doneText === "function" ? doneText(result) : doneText, "");
    return result;
  } catch (error) {
    setStatus(statusNode, error.message, "err");
    throw error;
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = label;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Tabs                                                                */
/* ------------------------------------------------------------------ */

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => {
      const active = t === tab;
      t.classList.toggle("is-active", active);
      t.setAttribute("aria-selected", String(active));
      $(`tab-${t.dataset.tab}`).hidden = !active;
    });
  });
});

$("openDashboard").addEventListener("click", () => send("openDashboard").then(() => window.close()));

/* ------------------------------------------------------------------ */
/* Profiles                                                            */
/* ------------------------------------------------------------------ */

let profiles = [];
let editingId = null;
let pendingFit = null; // { fitProfile, fitProfileVersion } awaiting Save

/**
 * The uploaded PDF for the current editing session, held in memory only.
 * It is deliberately not persisted: the extracted text is the durable artifact,
 * and base64 PDFs would bloat chrome.storage.local for no lasting benefit.
 */
let pendingPdf = null; // { name, data (base64) }

function fitSummaryText(fit) {
  const summary = $("fitSummary");
  summary.replaceChildren();
  if (!fit) {
    summary.hidden = true;
    return;
  }
  summary.hidden = false;

  const heading = document.createElement("h4");
  heading.textContent = "Fit Profile";
  summary.appendChild(heading);

  const lines = [
    ["Domain", fit.primaryDomain],
    ["Experience", fit.experienceBand || (fit.experienceYears ? `${fit.experienceYears} yrs` : "")],
    ["Primary roles", (fit.primaryRoles || []).slice(0, 3).join(", ")],
    ["Adjacent roles", (fit.adjacentRoles || []).slice(0, 4).join(", ")],
  ];
  for (const [label, value] of lines) {
    if (!value) continue;
    const p = document.createElement("p");
    const b = document.createElement("b");
    b.textContent = `${label}: `;
    p.append(b, document.createTextNode(value));
    summary.appendChild(p);
  }
}

async function renderProfiles() {
  profiles = await send("getProfiles");
  const active = await send("getActiveProfile");

  const select = $("activeProfile");
  select.replaceChildren();
  for (const profile of profiles) {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = profile.fitProfile ? profile.name : `${profile.name} (no Fit Profile)`;
    option.selected = active?.id === profile.id;
    select.appendChild(option);
  }
  select.disabled = profiles.length === 0;

  const list = $("profileList");
  list.replaceChildren();
  for (const profile of profiles) {
    const li = document.createElement("li");

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = profile.name;
    li.appendChild(name);

    const badge = document.createElement("span");
    badge.className = `badge${profile.fitProfile ? " ready" : ""}`;
    badge.textContent = profile.fitProfile ? "ready" : "no fit profile";
    li.appendChild(badge);

    const actions = document.createElement("span");
    actions.className = "actions";

    const edit = document.createElement("button");
    edit.type = "button";
    edit.title = "Edit";
    edit.textContent = "✎";
    edit.addEventListener("click", () => openEditor(profile));
    actions.appendChild(edit);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.title = "Delete";
    remove.textContent = "🗑";
    remove.addEventListener("click", async () => {
      if (!confirm(`Delete “${profile.name}” and its scored-jobs history?`)) return;
      await send("deleteProfile", { id: profile.id });
      if (editingId === profile.id) closeEditor();
      renderProfiles();
    });
    actions.appendChild(remove);

    li.appendChild(actions);
    list.appendChild(li);
  }

  $("emptyProfiles").hidden = profiles.length > 0;
}

function openEditor(profile) {
  editingId = profile?.id || null;
  pendingFit = null;
  clearPdf();
  $("profileName").value = profile?.name || "";
  $("profileCv").value = profile?.cv || "";
  updateCvChars();
  fitSummaryText(profile?.fitProfile || null);
  setStatus($("editorStatus"), "");
  $("editor").hidden = false;
  $("profileName").focus();
}

function closeEditor() {
  editingId = null;
  pendingFit = null;
  clearPdf();
  $("editor").hidden = true;
}

function updateCvChars() {
  $("cvChars").textContent = `${$("profileCv").value.length.toLocaleString()} characters`;
}

function clearPdf() {
  pendingPdf = null;
  $("sendPdfRow").hidden = true;
  $("sendPdf").checked = false;
  $("sendPdfWhy").textContent = "";
}

$("newProfile").addEventListener("click", () => openEditor(null));
$("cancelEdit").addEventListener("click", closeEditor);
$("profileCv").addEventListener("input", updateCvChars);

$("activeProfile").addEventListener("change", (event) =>
  send("setActiveProfile", { id: event.target.value }),
);

/* ---------------- CV upload ---------------- */

async function loadPdf(file) {
  const buffer = await file.arrayBuffer();

  // Encode before parsing: pdf.js transfers its input to a worker, and a
  // detached buffer cannot be read back.
  pendingPdf = { name: file.name, data: toBase64(buffer) };

  const extracted = await extractPdfText(buffer);
  $("sendPdfRow").hidden = false;

  if (!extracted.hasTextLayer) {
    // A scanned or image-only CV. Local extraction cannot help; the model
    // reading the rendered pages can.
    $("sendPdf").checked = true;
    $("sendPdfWhy").textContent = "(required — no text layer)";
    $("profileCv").value = extracted.text;
    updateCvChars();
    setStatus(
      $("editorStatus"),
      `${file.name} looks scanned — no selectable text. The PDF itself will be sent to the model instead.`,
      "err",
    );
    return;
  }

  $("profileCv").value = extracted.text;
  updateCvChars();

  const multiColumn = extracted.columnPages > 0;
  // A flattened two-column CV is the main way local extraction goes wrong, so
  // default to letting the model read the original when we detect one.
  $("sendPdf").checked = multiColumn;
  $("sendPdfWhy").textContent = multiColumn ? "(recommended — multi-column layout)" : "(optional)";

  const notes = [
    `${extracted.pagesRead} page${extracted.pagesRead === 1 ? "" : "s"}`,
    multiColumn ? "multi-column detected" : null,
    extracted.pageCount > extracted.pagesRead ? `first ${extracted.pagesRead} of ${extracted.pageCount}` : null,
  ].filter(Boolean);

  setStatus(
    $("editorStatus"),
    `Read ${file.name} (${notes.join(", ")}). Check the text below before generating.`,
    "",
  );
}

$("cvFileBtn").addEventListener("click", () => $("cvFile").click());

$("cvFile").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  event.target.value = ""; // allow re-picking the same file
  if (!file) return;

  clearPdf();
  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);

  try {
    if (isPdf) {
      setStatus($("editorStatus"), `Reading ${file.name}…`, "busy");
      await loadPdf(file);
    } else {
      $("profileCv").value = await file.text();
      updateCvChars();
      setStatus($("editorStatus"), `Loaded ${file.name}`, "");
    }
  } catch (error) {
    clearPdf();
    setStatus(
      $("editorStatus"),
      error instanceof PdfError ? error.message : `Could not read that file: ${error.message}`,
      "err",
    );
  }
});

$("generateFit").addEventListener("click", async () => {
  const cv = $("profileCv").value.trim();
  const pdf = $("sendPdf").checked ? pendingPdf : null;

  if (cv.length < 120 && !pdf) {
    setStatus($("editorStatus"), "Paste or upload the full CV first.", "err");
    return;
  }
  try {
    const result = await withStatus(
      $("generateFit"),
      $("editorStatus"),
      pdf ? "Reading the PDF…" : "Generating…",
      () => send("generateFitProfile", { cv, pdf }),
      "Fit Profile ready — press Save to keep it.",
    );
    pendingFit = result;
    fitSummaryText(result.fitProfile);
  } catch {
    /* status already shown */
  }
});

$("editor").addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = $("profileName").value.trim();
  const cv = $("profileCv").value.trim();
  const existing = profiles.find((p) => p.id === editingId);

  if (!name) {
    setStatus($("editorStatus"), "Give the profile a name.", "err");
    return;
  }
  // A scanned PDF leaves the text box empty — that is fine as long as a Fit
  // Profile was generated from the document itself.
  if (!cv && !pendingFit && !existing?.fitProfile) {
    setStatus($("editorStatus"), "Add a CV, or generate a Fit Profile from an uploaded PDF.", "err");
    return;
  }

  const patch = { id: editingId || undefined, name, cv };

  if (pendingFit) {
    patch.fitProfile = pendingFit.fitProfile;
    patch.fitProfileVersion = pendingFit.fitProfileVersion;
  } else if (existing?.fitProfile && existing.cv !== cv) {
    // The CV changed but the Fit Profile wasn't regenerated — keeping the stale
    // profile would silently score against the old CV.
    if (!confirm("The CV changed but the Fit Profile wasn't regenerated. Save anyway?")) return;
  }

  try {
    const saved = await withStatus(
      $("saveProfile"),
      $("editorStatus"),
      "Saving…",
      () => send("saveProfile", { profile: patch }),
      "Saved.",
    );
    if (profiles.length === 0) await send("setActiveProfile", { id: saved.id });
    closeEditor();
    renderProfiles();
  } catch {
    /* status already shown */
  }
});

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

const SETTING_FIELDS = {
  provider: "provider",
  apiKey: "apiKey",
  scoringModel: "scoringModel",
  profileModel: "profileModel",
  maxOutputTokens: "maxOutputTokens",
  rpm: "rpm",
  concurrency: "concurrency",
  autoScore: "autoScore",
  listingDots: "listingDots",
  quickScore: "quickScore",
};

function applyProviderHints(provider) {
  const spec = PROVIDERS[provider] || PROVIDERS.gemini;
  $("keyLink").href = spec.keyUrl;
  $("scoringModel").placeholder = spec.defaultScoringModel;
  $("profileModel").placeholder = spec.defaultProfileModel;
  $("rpm").placeholder = `auto (${spec.defaultRpm})`;
  // The list belongs to the previous provider's key — clear it.
  $("modelOptions").replaceChildren();
  $("modelHint").textContent = "";
}

/**
 * Populate the model suggestions from what this API key can actually call.
 * Provider model ids get retired and closed to new keys, so the key's own
 * answer is the only reliable source.
 */
async function loadModels({ quiet = false } = {}) {
  const button = $("refreshModels");
  const hint = $("modelHint");
  const label = button.textContent;

  button.disabled = true;
  button.textContent = "Loading…";
  if (!quiet) hint.textContent = "";

  try {
    const { models, recommended, total } = await send("listModels");
    $("modelOptions").replaceChildren(
      ...models.map((id) => {
        const option = document.createElement("option");
        option.value = id;
        return option;
      }),
    );
    hint.textContent = recommended
      ? `${models.length} usable of ${total}. Recommended: ${recommended}`
      : `No text models available on this key (${total} seen).`;
    return recommended;
  } catch (error) {
    hint.textContent = quiet ? "" : `Couldn't list models: ${error.message}`;
    return null;
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

$("refreshModels").addEventListener("click", () => loadModels());

async function renderSettings() {
  const select = $("provider");
  select.replaceChildren();
  for (const [id, spec] of Object.entries(PROVIDERS)) {
    const option = document.createElement("option");
    option.value = id;
    option.textContent = spec.label;
    select.appendChild(option);
  }

  const settings = await send("getSettings");
  for (const [key, id] of Object.entries(SETTING_FIELDS)) {
    const node = $(id);
    if (node.type === "checkbox") node.checked = Boolean(settings[key]);
    else node.value = settings[key] ?? "";
  }
  applyProviderHints(settings.provider);
}

$("provider").addEventListener("change", (event) => applyProviderHints(event.target.value));

$("saveSettings").addEventListener("click", async () => {
  const patch = {};
  for (const [key, id] of Object.entries(SETTING_FIELDS)) {
    const node = $(id);
    if (node.type === "checkbox") patch[key] = node.checked;
    else if (node.type === "number") patch[key] = Number(node.value) || 0;
    else patch[key] = node.value.trim();
  }
  withStatus(
    $("saveSettings"),
    $("settingsStatus"),
    "Saving…",
    () => send("setSettings", { patch }),
    "Saved.",
  ).catch(() => {});
});

$("testConnection").addEventListener("click", async () => {
  try {
    const result = await withStatus(
      $("testConnection"),
      $("settingsStatus"),
      "Testing…",
      () => send("testConnection"),
      (r) =>
        r.switchedFrom
          ? `“${r.switchedFrom}” was unavailable — switched to ${r.model}.`
          : `Connected — ${r.model}`,
    );
    // The worker may have re-picked the model for us; reflect that here.
    if (result.switchedFrom) {
      const settings = await send("getSettings");
      $("scoringModel").value = settings.scoringModel ?? "";
      $("profileModel").value = settings.profileModel ?? "";
      $("advanced").open = true;
    }
    loadModels({ quiet: true });
  } catch {
    /* status already shown */
  }
});

/* ------------------------------------------------------------------ */
/* Per-site enablement                                                 */
/* ------------------------------------------------------------------ */

const BUILT_IN = /(^|\.)(linkedin|naukri|indeed)\.com$/i;

async function renderSiteToggle() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const button = $("toggleSite");
  const label = $("siteName");

  let url;
  try {
    url = new URL(tab?.url || "");
  } catch {
    return;
  }
  if (url.protocol !== "https:") return;

  if (BUILT_IN.test(url.hostname)) {
    label.textContent = `${url.hostname} — supported out of the box`;
    return;
  }

  const origin = url.origin;
  const enabled = await send("isSiteEnabled", { origin });
  label.textContent = url.hostname;
  button.hidden = false;
  button.textContent = enabled ? "Disable here" : "Enable here";

  button.onclick = async () => {
    if (enabled) {
      await send("disableSite", { origin });
    } else {
      // Must be requested from this page — a user gesture doesn't survive the
      // hop into the service worker.
      const granted = await chrome.permissions.request({ origins: [`https://${url.hostname}/*`] });
      if (!granted) {
        setStatus($("settingsStatus"), "Permission denied.", "err");
        return;
      }
      const result = await send("enableSite", { origin });
      if (!result.ok) {
        setStatus($("settingsStatus"), result.error, "err");
        return;
      }
    }
    setStatus($("settingsStatus"), enabled ? "Disabled — reload the tab." : "Enabled — reload the tab.", "");
    renderSiteToggle();
  };
}

/* ------------------------------------------------------------------ */

renderProfiles();
renderSettings();
renderSiteToggle().catch(() => {});
