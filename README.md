# Job Fit Scorer

A Chrome (MV3) extension that scores any job posting on **LinkedIn, Naukri or Indeed** against your CV — and, crucially, against the *adjacent* and *transferable-skill* roles you could also win, not just your current job title.

No build step. No dependencies. Load the folder unpacked and it runs.

---

## How it works

The core idea is the **Fit Profile**. Your CV is sent to the AI exactly once, and the model returns a compact structured summary of the whole space of roles you could realistically fit:

```jsonc
{
  "primaryRoles":   ["Healthcare Strategy Consultant", "Pharma CI Analyst"],
  "adjacentRoles":  ["Competitive Intelligence Analyst (any industry)",
                     "Market Research Manager", "Corporate Strategy Analyst"],
  "growthRoles":    ["GenAI / Digital Transformation Consultant"],
  "transferableSkills": ["research synthesis works across industries", ...],
  "dealBreakers":   ["pure sales roles"]
}
```

Every job scan then sends only **that profile + the job description** — never the full CV again. That is what makes it simultaneously smarter (adjacency is reasoned about up front), cheaper (small prompts) and faster.

```
┌──────────────┐   one-time    ┌───────────┐
│  Your CV     │ ────────────► │Fit Profile│
└──────────────┘               └─────┬─────┘
                                     │  per job (small prompt)
┌──────────────┐                     ▼
│Job posting   │ ───────────► ┌─────────────┐ ──► score + category
└──────────────┘               │ AI provider │     + breakdown
                               └─────────────┘     + reasoning
```

### Scoring

| Criterion | Weight |
|---|---|
| Skills match | 40 |
| Experience fit | 25 |
| Role alignment | 20 |
| Location fit | 15 |

`overallScore` is the weighted total ÷ 10. When the model returns a complete breakdown the headline score is **recomputed from it** rather than trusted — models routinely return a breakdown that doesn't sum to the number they wrote. The model's own figure is retained as `modelScore`, and a large disagreement is surfaced in the widget instead of being hidden.

| Category | Meaning | Colour |
|---|---|---|
| Primary Fit | Core to your current expertise | Green |
| Adjacent Fit | Transferable skills, new context | Blue |
| Growth Stretch | Reachable with minor upskilling | Amber |
| Reach | Possible, significant gap | Amber |
| Poor Fit | Skip | Grey |

---

## Setup

**1 — Get an API key**

| Provider | Where | Notes |
|---|---|---|
| Google Gemini | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | Free tier; the recommended starting point |
| Anthropic Claude | [console.anthropic.com](https://console.anthropic.com/settings/keys) | Paid. A claude.ai subscription does **not** include API access |
| OpenAI | [platform.openai.com](https://platform.openai.com/api-keys) | Paid |

**2 — Load the extension**

1. Open `chrome://extensions/`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select this folder

**3 — Configure**

1. Click the extension icon → **Settings** → pick a provider, paste the key → **Save settings** → **Test**
2. **Profiles** → **+ New** → name it → **Upload PDF / TXT** (or paste the text) → **Generate Fit Profile** → **Save**
3. Confirm the profile is selected under **Score jobs as**

**4 — Use it**

Open any job page. A badge appears bottom-right; hover or click it to expand the reasoning. Drag it anywhere — the position is remembered.

Switch **Score jobs as** at any time to evaluate the same market as a different person. Scores are cached per profile, so two profiles never share results.

---

## CV input

**PDF is the primary path.** Upload one and the text is extracted on-device with a vendored copy of pdf.js — nothing is uploaded to parse it. The extracted text lands in the editable text box so you can check it before generating anything.

The hard part is reading order, not decoding. Many CVs are two-column (a skills/contact rail beside the experience section), and a naive extraction interleaves the columns line by line into text that reads as nonsense. So the extractor detects the vertical gutter and reads each column through in turn. Where it finds one, it also ticks **Send the original PDF to the model** by default — the model reading the rendered page is more reliable than any flattening heuristic, and the Fit Profile is generated once, so it is worth getting right.

| Your PDF | What happens |
|---|---|
| Normal single-column | Extracted locally. Text-only by default. |
| Two-column / designed | Extracted locally **and** the original PDF is sent, so the model can resolve layout itself. |
| Scanned or image-only | No text to extract. The PDF is sent to the model, which reads the pages directly. |
| Password-protected | Refused with a clear message — remove the password and re-upload. |

The original PDF is held **in memory for the editing session only**. It is never written to `chrome.storage` — the extracted text is the durable artifact, which keeps storage small and means a CV isn't sitting on disk in two formats.

`.txt` and `.md` also work, as does pasting.

## Features

- **Multi-profile** — several people (or several career directions) side by side, each with its own CV, Fit Profile and history.
- **Floating widget** — score, category, per-criterion bars, why it fits, gaps, stretch, salary flag, and an Apply / Maybe / Skip call. Draggable and pinnable.
- **Dedup + cache** — a job is scored once per profile. Re-opening it is free and instant. Regenerating a Fit Profile invalidates the old scores automatically.
- **Search-results dots** — cached scores appear next to result cards for free. Optional *quick score* mode scores uncached cards from their snippet; those are marked `~` and are never allowed to overwrite a full score.
- **History dashboard** — sort, filter, search, add per-job notes and an application status, export to CSV.
- **Any site, opt-in** — Settings offers *Enable here* on unsupported job boards. Extraction falls back to schema.org `JobPosting` JSON-LD, which most ATS-hosted boards emit.

---

## Architecture

```
manifest.json
src/
  shared/            ESM — used by the worker and extension pages
    constants.js       config, rubric weights, provider defaults
    storage.js         chrome.storage wrapper + per-key write locks
    schema.js          output normalisation + JSON schemas
    jobkey.js          stable job identity + fit-profile fingerprint
    pdf.js             on-device PDF text + column-aware reading order
    csv.js             RFC 4180 export
  background/        ESM service worker (type: "module")
    service-worker.js  message router
    scoring.js         cache → in-flight dedup → AI call → persist
    sites.js           dynamic content-script registration
    ai/
      index.js           provider dispatch, rate limit, retry/backoff
      providers.js       Gemini / Claude / OpenAI adapters
      prompts.js         system + user prompts (bump PROMPT_VERSION on edit)
      json.js            brace-balanced JSON extraction
      limiter.js         token bucket + concurrency queue
  content/           classic scripts, share window.JFS
    extractors.js      JSON-LD → site selectors → body fallback
    widget.js          Shadow-DOM result widget
    listings.js        search-results score dots
    main.js            run orchestration + SPA navigation
  popup/  dashboard/ extension pages (ESM)
  vendor/pdfjs/      pdf.js 6.2.108 legacy build (Apache-2.0), ~1.8 MB
tests/
  logic.test.mjs     node tests/logic.test.mjs
  pdf.test.mjs       node tests/pdf.test.mjs
```

**Design decisions worth knowing:**

- **The worker is the only storage writer.** Popup, dashboard and content scripts all mutate through messages, so the per-key promise locks in `storage.js` actually serialise everything. chrome.storage has no transactions; without this, two tabs finishing a score at the same moment silently lose one of them.
- **The widget lives in a Shadow DOM.** LinkedIn ships extremely aggressive global CSS. Injecting into the page's style scope means the widget eventually breaks; a shadow root means it can't.
- **Model output is never `innerHTML`.** Both the AI response and the job description are untrusted input; everything is set with `textContent`.
- **Navigation is polled, not observed.** A document-wide `MutationObserver` on a job board fires constantly. One string comparison every 700 ms costs far less, and each run carries a token so a late response for a previous job is discarded rather than rendered over the current one.
- **Content extraction waits for the DOM to settle**, rather than assuming a fixed delay — a hard-coded `setTimeout` either fires too early on a slow connection or wastes time on a fast one.
- **All AI calls go through one rate limiter** (token bucket + concurrency cap) with exponential backoff and `Retry-After` support. Without it, one search page with batch scoring on earns an instant 429.

---

## Cost

Every scan sends roughly 700–1,500 tokens (compact Fit Profile + trimmed JD) and receives ~300.

| | Fit Profile (once per CV) | Per job scan | ~30 scans/day |
|---|---|---|---|
| Gemini Flash | free tier | free tier | ₹0 |
| Claude Haiku | ~₹1 | ~₹0.25 | ~₹8 |
| GPT-4o-mini | ~₹0.8 | ~₹0.20 | ~₹6 |

Start on Gemini's free tier and only move if you hit its limits.

---

## Configuration reference

Settings → **Advanced**:

**Models are discovered, not hardcoded.** Providers retire model ids and close older ones to new API keys without notice, so any compiled-in default has a shelf life. **Load available** queries your key for the models it can actually call and offers them as suggestions, best-first. If **Test** hits a dead model it re-picks a supported one, saves it, and retries — so a stale default self-heals instead of dead-ending.

| Setting | Default | Notes |
|---|---|---|
| Scoring model | best available | Type any id, or pick from the discovered list |
| Fit-profile model | best available | Worth pointing at a stronger model — it runs once per CV |
| Max output tokens | 4000 | Current models think by default and thinking tokens count against this — too tight and the response comes back empty |
| Requests / min | auto | 0 uses the provider default (Gemini 12, others 30) |
| Max concurrent calls | 3 | Only matters for batch/quick scoring |

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| *"looks scanned — no selectable text"* | Image-only PDF | Nothing to fix — the PDF itself is sent to the model. Gemini and Claude handle this well; on OpenAI prefer a text-based export. |
| Extracted text is jumbled | Unusual layout the gutter detector missed | Edit the text box directly, or tick **Send the original PDF** and let the model read it |
| *"password-protected"* | Encrypted PDF | Open it, print/export to a new unprotected PDF, re-upload |
| *"no longer available to new users"* / 404 on the model | Provider retired that model id for new keys | Settings → **Test**. It re-picks a supported model automatically. Or **Advanced → Load available** and choose one. |
| Badge says "No API key set" | Key not saved | Popup → Settings → paste → Save |
| Badge says "no Fit Profile yet" | CV added but not processed | Popup → edit profile → Generate Fit Profile → **Save** |
| Badge never appears | Not a job detail page, or JD too short | Confirm it's a detail page; check the console |
| "Couldn't read this job description" | Site changed its DOM | Update the selectors in `src/content/extractors.js` — nothing else needs to change |
| Claude request fails with a CORS error | Missing browser header | Already sent as `anthropic-dangerous-direct-browser-access` — check the key is a real API key |
| "hit the output token limit" | Model spent the budget thinking | Raise **Max output tokens** (try 8000), or pick a lighter model |
| Bare *"400 Request contains an invalid argument"* | A `generationConfig` field this model rejects | Retried automatically with a minimal request; the error now names the offending field |
| Repeated 429s | Free-tier rate limit | Lower **Requests / min**, or turn off quick scoring |
| Scores look stale after editing a CV | Fit Profile not regenerated | Regenerate it — that automatically invalidates the cached scores |

Background-worker logs: `chrome://extensions` → **service worker** under this extension. Content-script logs: the page's own console.

---

## Security notes

- Keys live in `chrome.storage.local` — device-only, never synced, never sent anywhere except the provider you selected.
- PDFs are parsed **on-device**. Nothing is uploaded to read them.
- CV content is sent to your chosen provider on Fit Profile generation only — and only the original PDF if you leave that box ticked. Job scans send the derived profile, never the CV.
- The uploaded PDF is never persisted; it lives in the popup's memory until you close the editor.
- Host permissions are limited to the three supported boards plus the three API endpoints. Any other site is opt-in and individually revocable.
- The extension requests no `tabs` permission and reads no browsing history.

---

## Extending it

- **A site changes its DOM** → edit only `src/content/extractors.js`. Selectors live nowhere else.
- **Add a job board** → add an entry to `SITES` in `extractors.js` and a match pattern in `manifest.json`. Or just use *Enable here* if the board emits JSON-LD.
- **Change the rubric** → `WEIGHTS` in `constants.js`, the prompt in `ai/prompts.js`, and the clamps in `schema.js`. **Bump `PROMPT_VERSION`** or old cached scores keep being served.
- **Add a provider** → one adapter in `ai/providers.js` returning `{ text, meta }`, plus an entry in `PROVIDERS`.

Run `node tests/logic.test.mjs` after touching parsing, normalisation, key derivation, or the limiter.
