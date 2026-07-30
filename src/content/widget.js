/**
 * Floating result widget (classic content script).
 *
 * Rendered inside a Shadow DOM so that host-page CSS (LinkedIn ships very
 * aggressive global styles) cannot break the layout and our styles cannot leak
 * into the page. Every value coming from the model or the job posting is set
 * with textContent — never innerHTML — because both are untrusted input.
 *
 * Exposes window.JFS.Widget.
 */

(() => {
  const JFS = (window.JFS = window.JFS || {});
  if (JFS.Widget) return;

  const HOST_ID = "job-fit-scorer-root";
  const POSITION_KEY = "jfs:widget-position";

  const CATEGORY_COLORS = {
    "Primary Fit": "#15803d",
    "Adjacent Fit": "#1d4ed8",
    "Growth Stretch": "#b45309",
    Reach: "#a16207",
    "Poor Fit": "#4b5563",
  };

  const STYLES = `
    :host { all: initial; }
    * { box-sizing: border-box; }
    .root {
      position: fixed; z-index: 2147483647;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      font-size: 13px; line-height: 1.5; color: #111827;
    }
    .pill {
      display: inline-flex; align-items: center; gap: 8px;
      padding: 9px 14px; border-radius: 999px;
      background: #4b5563; color: #fff;
      font-size: 13px; font-weight: 600; white-space: nowrap;
      box-shadow: 0 6px 20px rgba(0,0,0,.24); cursor: grab; user-select: none;
      transition: background .18s ease;
    }
    .pill:active { cursor: grabbing; }
    .pill .score { font-size: 15px; font-variant-numeric: tabular-nums; }
    .pill .sep { opacity: .5; }
    .pill .spinner {
      width: 12px; height: 12px; border-radius: 50%;
      border: 2px solid rgba(255,255,255,.35); border-top-color: #fff;
      animation: spin .8s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    .panel {
      position: absolute; bottom: calc(100% + 10px); right: 0;
      width: 340px; max-height: 70vh; overflow-y: auto;
      background: #fff; border: 1px solid #e5e7eb; border-radius: 14px;
      padding: 14px 16px; box-shadow: 0 16px 44px rgba(0,0,0,.22);
      display: none;
    }
    .panel.open { display: block; }
    .root.flip-up .panel { bottom: auto; top: calc(100% + 10px); }
    .root.flip-left .panel { right: auto; left: 0; }

    .head { display: flex; align-items: baseline; gap: 8px; margin-bottom: 10px; }
    .head .big { font-size: 26px; font-weight: 700; font-variant-numeric: tabular-nums; }
    .head .of { color: #6b7280; font-size: 12px; }
    .tag { margin-left: auto; padding: 3px 9px; border-radius: 999px; color: #fff; font-size: 11px; font-weight: 700; }

    .maps { font-size: 12px; color: #374151; margin-bottom: 10px; }
    .maps b { color: #111827; }

    .bars { display: grid; gap: 6px; margin-bottom: 12px; }
    .bar { display: grid; grid-template-columns: 78px 1fr 40px; align-items: center; gap: 8px; font-size: 11px; color: #4b5563; }
    .track { height: 6px; border-radius: 999px; background: #eef1f5; overflow: hidden; }
    .fill { height: 100%; border-radius: 999px; background: #2563eb; }
    .bar .val { text-align: right; font-variant-numeric: tabular-nums; color: #6b7280; }

    .row { margin-bottom: 9px; font-size: 12.5px; }
    .row .label { display: block; font-weight: 700; font-size: 11px; letter-spacing: .02em; text-transform: uppercase; margin-bottom: 2px; }
    .row.fits .label { color: #15803d; }
    .row.gaps .label { color: #b45309; }
    .row.stretch .label { color: #7c3aed; }
    .row.salary .label { color: #0f766e; }

    .rec { margin: 12px 0 4px; padding: 8px 10px; border-radius: 9px; background: #f3f6fb; font-weight: 700; color: #1d4ed8; text-align: center; }
    .rec.skip { background: #f4f4f5; color: #52525b; }
    .rec.maybe { background: #fef6e7; color: #b45309; }

    .note { font-size: 11px; color: #6b7280; margin-top: 8px; }
    .note.warn { color: #b45309; }

    .actions { display: flex; gap: 6px; margin-top: 12px; padding-top: 10px; border-top: 1px solid #f0f2f5; }
    .actions button {
      flex: 1; padding: 6px 8px; border: 1px solid #d7dbe0; border-radius: 8px;
      background: #fff; font: inherit; font-size: 12px; color: #374151; cursor: pointer;
    }
    .actions button:hover { background: #f6f8fa; }
    .actions button:focus-visible { outline: 2px solid #2563eb; outline-offset: 1px; }

    .error { color: #b91c1c; font-size: 12.5px; }

    @media (prefers-color-scheme: dark) {
      .panel { background: #14181f; border-color: #2a3039; color: #e5e7eb; }
      .head .big, .maps b { color: #f3f4f6; }
      .maps, .row { color: #cbd5e1; }
      .track { background: #262d38; }
      .rec { background: #182234; color: #93b4fb; }
      .rec.skip { background: #22262d; color: #a1a1aa; }
      .rec.maybe { background: #2b2113; color: #fbbf24; }
      .actions { border-top-color: #262d38; }
      .actions button { background: #1b212a; border-color: #333b47; color: #d7dce4; }
      .actions button:hover { background: #232b36; }
    }
  `;

  const BREAKDOWN_LABELS = [
    ["skillsMatch", "Skills", 40],
    ["experienceFit", "Experience", 25],
    ["roleAlignment", "Role", 20],
    ["locationFit", "Location", 15],
  ];

  function el(tag, className, textContent) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (textContent !== undefined) node.textContent = textContent;
    return node;
  }

  function labelledRow(cls, label, value) {
    const row = el("div", `row ${cls}`);
    row.appendChild(el("span", "label", label));
    row.appendChild(document.createTextNode(value || "—"));
    return row;
  }

  class Widget {
    constructor() {
      this.handlers = {};
      this.pinned = false;
      this.#build();
    }

    #build() {
      document.getElementById(HOST_ID)?.remove();

      this.host = el("div");
      this.host.id = HOST_ID;
      // The host itself is a zero-size anchor; the shadow root positions itself.
      this.host.style.cssText = "all:initial;position:static;";
      const shadow = this.host.attachShadow({ mode: "open" });

      const style = document.createElement("style");
      style.textContent = STYLES;
      shadow.appendChild(style);

      this.root = el("div", "root");
      this.pill = el("div", "pill");
      this.panel = el("div", "panel");
      this.root.append(this.panel, this.pill);
      shadow.appendChild(this.root);
      document.documentElement.appendChild(this.host);

      this.#restorePosition();
      this.#wireInteractions();
      this.setLoading("Analysing…");
    }

    /* ---------------- positioning + drag ---------------- */

    #restorePosition() {
      let saved = null;
      try {
        saved = JSON.parse(localStorage.getItem(POSITION_KEY) || "null");
      } catch {
        /* storage may be blocked; fall back to the default corner */
      }
      const right = Number.isFinite(saved?.right) ? saved.right : 20;
      const bottom = Number.isFinite(saved?.bottom) ? saved.bottom : 20;
      this.root.style.right = `${right}px`;
      this.root.style.bottom = `${bottom}px`;
      this.#updateFlip();
    }

    #savePosition() {
      try {
        localStorage.setItem(
          POSITION_KEY,
          JSON.stringify({
            right: parseFloat(this.root.style.right) || 20,
            bottom: parseFloat(this.root.style.bottom) || 20,
          }),
        );
      } catch {
        /* non-fatal */
      }
    }

    /** Flip the panel when the pill sits too close to an edge to open normally. */
    #updateFlip() {
      const bottom = parseFloat(this.root.style.bottom) || 20;
      const right = parseFloat(this.root.style.right) || 20;
      this.root.classList.toggle("flip-up", bottom > window.innerHeight - 380);
      this.root.classList.toggle("flip-left", right > window.innerWidth - 360);
    }

    #wireInteractions() {
      let drag = null;

      this.pill.addEventListener("pointerdown", (event) => {
        if (event.button !== 0) return;
        drag = {
          x: event.clientX,
          y: event.clientY,
          right: parseFloat(this.root.style.right) || 20,
          bottom: parseFloat(this.root.style.bottom) || 20,
          moved: false,
        };
        this.pill.setPointerCapture(event.pointerId);
      });

      this.pill.addEventListener("pointermove", (event) => {
        if (!drag) return;
        const dx = drag.x - event.clientX;
        const dy = drag.y - event.clientY;
        if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
        this.root.style.right = `${Math.max(4, Math.min(drag.right + dx, window.innerWidth - 80))}px`;
        this.root.style.bottom = `${Math.max(4, Math.min(drag.bottom + dy, window.innerHeight - 50))}px`;
        this.#updateFlip();
      });

      this.pill.addEventListener("pointerup", (event) => {
        if (!drag) return;
        this.pill.releasePointerCapture(event.pointerId);
        // A drag should not also count as a click-to-pin.
        if (!drag.moved) this.#togglePinned();
        else this.#savePosition();
        drag = null;
      });

      this.root.addEventListener("mouseenter", () => this.#setPanelOpen(true));
      this.root.addEventListener("mouseleave", () => this.#setPanelOpen(this.pinned));
    }

    #setPanelOpen(open) {
      this.panel.classList.toggle("open", Boolean(open) && this.panel.childElementCount > 0);
    }

    #togglePinned() {
      this.pinned = !this.pinned;
      this.#setPanelOpen(this.pinned);
    }

    /* ---------------- rendering ---------------- */

    on(event, handler) {
      this.handlers[event] = handler;
      return this;
    }

    #setPill({ color, spinner, score, label }) {
      this.pill.replaceChildren();
      this.pill.style.background = color;
      if (spinner) this.pill.appendChild(el("span", "spinner"));
      if (score !== undefined) {
        this.pill.appendChild(el("span", "score", score));
        this.pill.appendChild(el("span", "sep", "·"));
      }
      this.pill.appendChild(el("span", "label", label));
    }

    setLoading(message = "Analysing…") {
      this.#setPill({ color: "#4b5563", spinner: true, label: message });
      this.panel.replaceChildren();
      this.#setPanelOpen(false);
    }

    setError(message, { retry = true } = {}) {
      this.#setPill({ color: "#4b5563", label: "Job Fit" });
      this.panel.replaceChildren();
      this.panel.appendChild(el("div", "error", message));
      this.panel.appendChild(this.#actions({ retry, rescoreLabel: "Try again" }));
      this.#setPanelOpen(true);
      this.pinned = true;
    }

    setIdle(message, actionLabel, action) {
      this.#setPill({ color: "#4b5563", label: "Job Fit" });
      this.panel.replaceChildren();
      this.panel.appendChild(el("div", "row", message));
      if (actionLabel) {
        const actions = el("div", "actions");
        const button = el("button", null, actionLabel);
        button.addEventListener("click", action);
        actions.appendChild(button);
        this.panel.appendChild(actions);
      }
      this.#setPanelOpen(true);
      this.pinned = true;
    }

    #actions({ retry = true, rescoreLabel = "Rescore" } = {}) {
      const actions = el("div", "actions");

      if (retry) {
        const rescore = el("button", null, rescoreLabel);
        rescore.addEventListener("click", () => this.handlers.rescore?.());
        actions.appendChild(rescore);
      }

      const history = el("button", null, "History");
      history.addEventListener("click", () => this.handlers.dashboard?.());
      actions.appendChild(history);

      const hide = el("button", null, "Hide");
      hide.addEventListener("click", () => this.destroy());
      actions.appendChild(hide);

      return actions;
    }

    render(result, { cached = false, profileName = "" } = {}) {
      const color = CATEGORY_COLORS[result.roleCategory] || "#4b5563";
      const quick = result.mode === "quick";
      this.#setPill({
        color,
        score: `${quick ? "~" : ""}${result.overallScore}`,
        label: result.roleCategory,
      });

      this.panel.replaceChildren();

      const head = el("div", "head");
      head.appendChild(el("span", "big", String(result.overallScore)));
      head.appendChild(el("span", "of", "/ 10"));
      const tag = el("span", "tag", result.roleCategory);
      tag.style.background = color;
      head.appendChild(tag);
      this.panel.appendChild(head);

      if (result.matchType) {
        const maps = el("div", "maps");
        maps.appendChild(el("b", null, "Maps to: "));
        maps.appendChild(document.createTextNode(result.matchType));
        this.panel.appendChild(maps);
      }

      const bars = el("div", "bars");
      for (const [key, label, max] of BREAKDOWN_LABELS) {
        const value = result.breakdown?.[key] ?? 0;
        const bar = el("div", "bar");
        bar.appendChild(el("span", null, label));
        const track = el("div", "track");
        const fill = el("div", "fill");
        fill.style.width = `${Math.round((value / max) * 100)}%`;
        fill.style.background = color;
        track.appendChild(fill);
        bar.appendChild(track);
        bar.appendChild(el("span", "val", `${value}/${max}`));
        bars.appendChild(bar);
      }
      this.panel.appendChild(bars);

      this.panel.appendChild(labelledRow("fits", "Why it fits", result.whyFits));
      this.panel.appendChild(labelledRow("gaps", "Gaps", result.gaps));
      if (result.growthStretch) this.panel.appendChild(labelledRow("stretch", "Stretch", result.growthStretch));
      if (result.salaryFitFlag && result.salaryFitFlag !== "Unknown") {
        this.panel.appendChild(labelledRow("salary", "Salary", result.salaryFitFlag));
      }

      const rec = el("div", `rec ${result.recommendation.toLowerCase()}`, result.recommendation);
      this.panel.appendChild(rec);

      const notes = [];
      if (profileName) notes.push(`Scored as ${profileName}`);
      if (cached) notes.push("cached");
      if (quick) notes.push("preliminary — from search snippet");
      if (notes.length) this.panel.appendChild(el("div", "note", notes.join(" · ")));

      if (result.scoreDerived && Math.abs(result.modelScore - result.overallScore) >= 1.5) {
        this.panel.appendChild(
          el(
            "div",
            "note warn",
            `Model reported ${result.modelScore}; showing ${result.overallScore} recomputed from the rubric weights.`,
          ),
        );
      }

      this.panel.appendChild(this.#actions());
      this.#setPanelOpen(this.pinned);
    }

    destroy() {
      this.host?.remove();
      this.host = null;
    }

    get attached() {
      return Boolean(this.host?.isConnected);
    }
  }

  JFS.Widget = Widget;
})();
