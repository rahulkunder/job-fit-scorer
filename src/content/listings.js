/**
 * Search-results overlay (classic content script).
 *
 * Injects a small score dot into each result card. By default it only shows
 * scores that are already cached — that is free, instant, and covers the common
 * case of revisiting a search page. Optional "quick score" mode scores the
 * uncached cards from their snippet text; those results are marked preliminary
 * (`~` prefix, quick mode) and never overwrite a full score.
 *
 * Exposes window.JFS.Listings.
 */

(() => {
  const JFS = (window.JFS = window.JFS || {});
  if (JFS.Listings) return;

  const MARKER = "data-jfs-dot";
  const MAX_QUICK_PER_PASS = 12;

  const CATEGORY_COLORS = {
    "Primary Fit": "#15803d",
    "Adjacent Fit": "#1d4ed8",
    "Growth Stretch": "#b45309",
    Reach: "#a16207",
    "Poor Fit": "#4b5563",
  };

  const DOT_CSS = `
    all: initial;
    display: inline-flex; align-items: center; justify-content: center;
    min-width: 30px; height: 20px; padding: 0 6px; margin-left: 6px;
    border-radius: 999px; vertical-align: middle;
    font: 700 11px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    color: #fff; cursor: default;
  `;

  function paint(card, result) {
    card.querySelector(`[${MARKER}]`)?.remove();

    const dot = document.createElement("span");
    dot.setAttribute(MARKER, "1");
    dot.style.cssText = `${DOT_CSS} background:${CATEGORY_COLORS[result.roleCategory] || "#4b5563"};`;
    dot.textContent = `${result.mode === "quick" ? "~" : ""}${result.overallScore}`;
    dot.title = [
      `${result.overallScore}/10 · ${result.roleCategory}`,
      result.matchType,
      result.whyFits,
      result.mode === "quick" ? "(preliminary — from search snippet)" : "",
    ]
      .filter(Boolean)
      .join("\n");

    // Anchor next to the title when we can find it, so the dot rides along with
    // whatever layout the site uses.
    const anchor =
      card.querySelector("a.title, h2.jobTitle, .job-card-list__title--link, .job-card-list__title, strong") || card;
    anchor.appendChild(dot);
  }

  class Listings {
    constructor({ send, getContext }) {
      this.send = send;
      this.getContext = getContext;
      this.painted = new Map();
      this.running = false;
    }

    async refresh({ quick = false } = {}) {
      if (this.running) return;
      const context = this.getContext();
      if (!context?.profile?.hasFitProfile) return;

      const cards = JFS.Extractors.listings();
      if (!cards.length) return;

      this.running = true;
      try {
        const cached = await this.send("lookupCached", {
          jobs: cards.map(({ element, ...rest }) => rest),
          profileId: context.profile.id,
        });

        const byRef = new Map((cached || []).map((entry) => [entry.ref, entry]));
        const pending = [];

        for (const card of cards) {
          const hit = byRef.get(card.ref);
          if (hit?.result) {
            if (card.element.isConnected) paint(card.element, hit.result);
            this.painted.set(card.ref, hit.result);
          } else if (quick && !this.painted.has(card.ref)) {
            pending.push(card);
          }
        }

        if (!quick || !pending.length) return;

        const batch = pending.slice(0, MAX_QUICK_PER_PASS);
        const scored = await this.send("scoreBatch", {
          jobs: batch.map(({ element, ...rest }) => rest),
          profileId: context.profile.id,
          mode: "quick",
        });

        const cardByRef = new Map(batch.map((c) => [c.ref, c]));
        for (const entry of scored || []) {
          if (!entry.ok || !entry.result) continue;
          const card = cardByRef.get(entry.ref);
          if (card?.element.isConnected) paint(card.element, entry.result);
          this.painted.set(entry.ref, entry.result);
        }
      } catch (error) {
        console.debug("[job-fit-scorer] listing pass failed:", error.message);
      } finally {
        this.running = false;
      }
    }

    clear() {
      document.querySelectorAll(`[${MARKER}]`).forEach((node) => node.remove());
      this.painted.clear();
    }
  }

  JFS.Listings = Listings;
})();
