/**
 * Content-script entry point (classic script).
 *
 * Responsibilities: detect a job page, wait for its description to render, ask
 * the background worker to score it, and drive the widget + listing overlay.
 *
 * Two things this guards carefully:
 *  - SPA navigation. LinkedIn swaps the whole job pane without a page load, so
 *    every run carries a token and a late response from a previous job is
 *    discarded instead of being rendered over the current one.
 *  - Worker lifetime. The MV3 service worker can be evicted, and the whole
 *    extension context is invalidated on reload/update; both surface as
 *    messaging errors that must not throw into the host page.
 */

(() => {
  const JFS = (window.JFS = window.JFS || {});
  if (JFS.booted) return;
  JFS.booted = true;

  const URL_POLL_MS = 700;
  const LISTING_DEBOUNCE_MS = 900;

  let runToken = 0;
  let widget = null;
  let context = null;
  let listings = null;
  let lastUrl = location.href;
  let listingTimer = null;

  /* ------------------------------------------------------------------ */
  /* Messaging                                                           */
  /* ------------------------------------------------------------------ */

  function send(action, payload = {}) {
    return new Promise((resolve, reject) => {
      let settled = false;
      try {
        chrome.runtime.sendMessage({ action, ...payload }, (response) => {
          if (settled) return;
          settled = true;
          const runtimeError = chrome.runtime.lastError;
          if (runtimeError) return reject(new Error(runtimeError.message));
          if (!response) return reject(new Error("No response from extension"));
          if (!response.ok) return reject(new Error(response.error || "Request failed"));
          resolve(response.data);
        });
      } catch (error) {
        // Thrown synchronously once the extension is reloaded/updated.
        if (!settled) reject(new Error("Extension was reloaded — refresh this page"));
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* Scoring run                                                         */
  /* ------------------------------------------------------------------ */

  function ensureWidget() {
    if (!widget || !widget.attached) {
      widget = new JFS.Widget();
      widget.on("rescore", () => run({ force: true })).on("dashboard", () => send("openDashboard"));
    }
    return widget;
  }

  async function run({ force = false } = {}) {
    const token = ++runToken;

    if (!JFS.Extractors.isDetailPage()) {
      widget?.destroy();
      widget = null;
      return;
    }

    try {
      context = await send("getContext");
    } catch (error) {
      console.debug("[job-fit-scorer]", error.message);
      return;
    }
    if (token !== runToken) return;

    if (!context.profile) {
      ensureWidget().setIdle("No profile yet. Open the extension and add your CV.", null);
      return;
    }
    if (!context.hasApiKey) {
      ensureWidget().setIdle("No API key set. Open the extension → Settings.", null);
      return;
    }
    if (!context.profile.hasFitProfile) {
      ensureWidget().setIdle(
        `“${context.profile.name}” has no Fit Profile yet. Open the extension and generate one.`,
        null,
      );
      return;
    }
    if (!context.settings.autoScore && !force) {
      ensureWidget().setIdle("Auto-scoring is off.", "Score this job", () => run({ force: true }));
      return;
    }

    const view = ensureWidget();
    view.setLoading("Reading job…");

    const jobData = await JFS.Extractors.waitForContent();
    if (token !== runToken) return;

    if (!jobData.description || jobData.description.length < 120) {
      view.setError("Couldn't read this job description. It may still be loading.");
      return;
    }

    view.setLoading("Scoring…");

    try {
      const scored = await send("scoreJob", {
        jobData,
        profileId: context.profile.id,
        mode: "full",
        force,
      });
      if (token !== runToken) return;
      view.render(scored.result, { cached: scored.cached, profileName: context.profile.name });
    } catch (error) {
      if (token !== runToken) return;
      view.setError(error.message);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Listing overlay                                                     */
  /* ------------------------------------------------------------------ */

  function scheduleListingPass() {
    if (!context?.settings?.listingDots) return;
    clearTimeout(listingTimer);
    listingTimer = setTimeout(() => {
      listings ||= new JFS.Listings({ send, getContext: () => context });
      listings.refresh({ quick: Boolean(context?.settings?.quickScore) });
    }, LISTING_DEBOUNCE_MS);
  }

  /* ------------------------------------------------------------------ */
  /* Navigation                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * Polling beats a document-wide MutationObserver here: job boards mutate the
   * DOM constantly, and we only care about the URL changing. One cheap string
   * comparison per 700ms costs far less than observing every subtree change.
   */
  setInterval(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    listings?.clear();
    run();
    scheduleListingPass();
  }, URL_POLL_MS);

  window.addEventListener("scroll", scheduleListingPass, { passive: true });

  // Re-render when the user switches the active profile in the popup.
  chrome.storage?.onChanged?.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.activeProfileId || changes.settings) {
      listings?.clear();
      run();
      scheduleListingPass();
    }
  });

  run();
  scheduleListingPass();
})();
