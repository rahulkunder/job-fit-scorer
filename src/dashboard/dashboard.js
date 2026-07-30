/**
 * History dashboard: browse, filter, sort, annotate and export scored jobs.
 * Read/write goes through the background worker (single writer — see popup.js).
 */

import { CATEGORIES, CATEGORY_COLORS } from "../shared/constants.js";
import { toCsv, HISTORY_COLUMNS } from "../shared/csv.js";

const $ = (id) => document.getElementById(id);

function send(action, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action, ...payload }, (response) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!response?.ok) return reject(new Error(response?.error || "Request failed"));
      resolve(response.data);
    });
  });
}

const STATUSES = ["none", "applied", "interviewing", "rejected", "archived"];
const STATUS_LABELS = {
  none: "—",
  applied: "Applied",
  interviewing: "Interviewing",
  rejected: "Rejected",
  archived: "Archived",
};

let profileId = null;
let rows = [];
let sort = { key: "savedAt", dir: "desc" };

const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/* ------------------------------------------------------------------ */
/* Data                                                                */
/* ------------------------------------------------------------------ */

async function loadProfiles() {
  const [profiles, active] = await Promise.all([send("getProfiles"), send("getActiveProfile")]);
  const select = $("profile");
  select.replaceChildren();
  for (const profile of profiles) {
    const option = el("option", null, profile.name || "(unnamed)");
    option.value = profile.id;
    option.selected = active?.id === profile.id;
    select.appendChild(option);
  }
  profileId = select.value || null;
}

async function loadHistory() {
  rows = profileId ? await send("getHistory", { profileId }) : [];
  render();
}

/* ------------------------------------------------------------------ */
/* Filtering + sorting                                                 */
/* ------------------------------------------------------------------ */

function visibleRows() {
  const query = $("search").value.trim().toLowerCase();
  const category = $("category").value;
  const recommendation = $("recommendation").value;
  const status = $("status").value;
  const fullOnly = $("hideQuick").checked;

  const filtered = rows.filter((row) => {
    const result = row.result || {};
    if (fullOnly && result.mode === "quick") return false;
    if (category && result.roleCategory !== category) return false;
    if (recommendation && result.recommendation !== recommendation) return false;
    if (status && (row.status || "none") !== status) return false;
    if (!query) return true;

    return [
      row.meta?.title,
      row.meta?.company,
      row.meta?.location,
      result.matchType,
      result.whyFits,
      result.gaps,
      row.notes,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(query);
  });

  const readers = {
    savedAt: (r) => r.savedAt || 0,
    title: (r) => (r.meta?.title || "").toLowerCase(),
    score: (r) => r.result?.overallScore ?? -1,
    category: (r) => CATEGORIES.indexOf(r.result?.roleCategory),
    recommendation: (r) => ["Apply", "Maybe", "Skip"].indexOf(r.result?.recommendation),
  };
  const read = readers[sort.key] || readers.savedAt;
  const direction = sort.dir === "asc" ? 1 : -1;

  return filtered.sort((a, b) => {
    const av = read(a);
    const bv = read(b);
    return av === bv ? 0 : (av > bv ? 1 : -1) * direction;
  });
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

function renderStats(list) {
  const stats = $("stats");
  stats.replaceChildren();
  if (!list.length) return;

  const scores = list.map((r) => r.result?.overallScore ?? 0);
  const cards = [
    ["Scored", list.length],
    ["Avg score", (scores.reduce((a, b) => a + b, 0) / list.length).toFixed(1)],
    ["Strong (8+)", scores.filter((s) => s >= 8).length],
    ["Recommended", list.filter((r) => r.result?.recommendation === "Apply").length],
    ["Applied", list.filter((r) => r.status === "applied").length],
  ];

  for (const [label, value] of cards) {
    const card = el("div", "stat");
    card.appendChild(el("div", "value", String(value)));
    card.appendChild(el("div", "label", label));
    stats.appendChild(card);
  }
}

function renderRow(row) {
  const result = row.result || {};
  const tr = el("tr");

  tr.appendChild(
    el("td", "when", row.savedAt ? new Date(row.savedAt).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }) : "—"),
  );

  const job = el("td", "job");
  if (row.meta?.url) {
    const link = el("a", null, row.meta.title || "(untitled)");
    link.href = row.meta.url;
    link.target = "_blank";
    link.rel = "noreferrer";
    job.appendChild(link);
  } else {
    job.appendChild(el("strong", null, row.meta?.title || "(untitled)"));
  }
  job.appendChild(
    el("div", "meta", [row.meta?.company, row.meta?.location].filter(Boolean).join(" · ") || "—"),
  );
  tr.appendChild(job);

  const score = el("td", "score");
  score.appendChild(document.createTextNode(String(result.overallScore ?? "—")));
  if (result.mode === "quick") score.appendChild(el("span", "quick", " ~quick"));
  tr.appendChild(score);

  const category = el("td");
  if (result.roleCategory) {
    const pill = el("span", "pill", result.roleCategory);
    pill.style.background = CATEGORY_COLORS[result.roleCategory] || "#4b5563";
    category.appendChild(pill);
  }
  if (result.matchType) category.appendChild(el("div", "meta", result.matchType));
  tr.appendChild(category);

  const reason = el("td", "reason");
  if (result.whyFits) reason.appendChild(el("div", null, result.whyFits));
  if (result.gaps) reason.appendChild(el("div", "gaps", result.gaps));
  tr.appendChild(reason);

  tr.appendChild(el("td", null, result.recommendation || "—"));

  const statusCell = el("td", "notes");
  const select = el("select");
  for (const value of STATUSES) {
    const option = el("option", null, STATUS_LABELS[value]);
    option.value = value;
    option.selected = (row.status || "none") === value;
    select.appendChild(option);
  }
  select.addEventListener("change", async () => {
    row.status = select.value;
    await send("updateHistoryEntry", { profileId, jobKey: row.jobKey, patch: { status: row.status } });
    renderStats(rows);
  });
  statusCell.appendChild(select);

  const notes = el("textarea");
  notes.placeholder = "Notes…";
  notes.value = row.notes || "";
  notes.addEventListener("change", async () => {
    row.notes = notes.value;
    await send("updateHistoryEntry", { profileId, jobKey: row.jobKey, patch: { notes: row.notes } });
  });
  statusCell.appendChild(notes);
  tr.appendChild(statusCell);

  const actions = el("td", "actions");
  const remove = el("button", null, "🗑");
  remove.type = "button";
  remove.title = "Delete this entry";
  remove.addEventListener("click", async () => {
    await send("deleteHistoryEntry", { profileId, jobKey: row.jobKey });
    rows = rows.filter((r) => r.jobKey !== row.jobKey);
    render();
  });
  actions.appendChild(remove);
  tr.appendChild(actions);

  return tr;
}

async function renderFooter() {
  const bytes = await send("getUsageBytes").catch(() => null);
  $("footer").textContent = bytes
    ? `${rows.length} entries · ${(bytes / 1024).toFixed(0)} KB of local storage used`
    : `${rows.length} entries`;
}

function render() {
  const list = visibleRows();
  const body = $("rows");
  body.replaceChildren();
  list.forEach((row) => body.appendChild(renderRow(row)));

  $("empty").hidden = list.length > 0;
  renderStats(rows);
  renderFooter();

  document.querySelectorAll("th.sortable").forEach((th) => {
    th.classList.toggle("asc", th.dataset.sort === sort.key && sort.dir === "asc");
    th.classList.toggle("desc", th.dataset.sort === sort.key && sort.dir === "desc");
  });
}

/* ------------------------------------------------------------------ */
/* Wiring                                                              */
/* ------------------------------------------------------------------ */

for (const value of CATEGORIES) {
  const option = el("option", null, value);
  option.value = value;
  $("category").appendChild(option);
}

["search", "category", "recommendation", "status", "hideQuick"].forEach((id) =>
  $(id).addEventListener("input", render),
);

document.querySelectorAll("th.sortable").forEach((th) =>
  th.addEventListener("click", () => {
    const key = th.dataset.sort;
    sort = sort.key === key ? { key, dir: sort.dir === "asc" ? "desc" : "asc" } : { key, dir: "desc" };
    render();
  }),
);

$("profile").addEventListener("change", (event) => {
  profileId = event.target.value;
  loadHistory();
});

$("exportCsv").addEventListener("click", () => {
  const list = visibleRows();
  if (!list.length) return;

  const csv = toCsv(list, HISTORY_COLUMNS);
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const name = ($("profile").selectedOptions[0]?.textContent || "profile").replace(/[^\w.-]+/g, "-");
  const link = document.createElement("a");
  link.href = url;
  link.download = `job-fit-${name}-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

$("clearAll").addEventListener("click", async () => {
  if (!profileId) return;
  if (!confirm("Delete all scored-job history for this profile? This cannot be undone.")) return;
  await send("clearHistory", { profileId });
  loadHistory();
});

await loadProfiles();
await loadHistory();
