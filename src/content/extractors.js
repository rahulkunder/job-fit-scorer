/**
 * Job-description extraction (classic content script).
 *
 * Site DOMs change constantly, so this file is the single place selectors live
 * — if extraction breaks, only this file needs editing. Three layers, in order:
 *   1. schema.org JobPosting JSON-LD (most stable; many boards emit it)
 *   2. site-specific selectors
 *   3. main/article body text
 *
 * Exposes window.JFS.Extractors. No storage or network access.
 */

(() => {
  const JFS = (window.JFS = window.JFS || {});
  if (JFS.Extractors) return;

  const MAX_DESCRIPTION = 12000;

  const text = (node) => (node?.innerText || node?.textContent || "").replace(/\s+/g, " ").trim();

  function pick(selectors, root = document) {
    for (const selector of selectors) {
      const node = root.querySelector(selector);
      const value = text(node);
      if (value) return value;
    }
    return "";
  }

  function pickRich(selectors, root = document) {
    for (const selector of selectors) {
      const node = root.querySelector(selector);
      const value = (node?.innerText || "").trim();
      if (value.length > 80) return value;
    }
    return "";
  }

  function htmlToText(html) {
    const doc = new DOMParser().parseFromString(String(html), "text/html");
    return (doc.body.innerText || doc.body.textContent || "").trim();
  }

  /* ---------------------------------------------------------------- */
  /* schema.org JobPosting                                             */
  /* ---------------------------------------------------------------- */

  function flatten(node, out = []) {
    if (Array.isArray(node)) node.forEach((n) => flatten(n, out));
    else if (node && typeof node === "object") {
      out.push(node);
      if (node["@graph"]) flatten(node["@graph"], out);
    }
    return out;
  }

  function jsonLd() {
    for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
      let parsed;
      try {
        parsed = JSON.parse(script.textContent);
      } catch {
        continue; // malformed blocks are common; skip quietly
      }
      const posting = flatten(parsed).find((n) => {
        const type = n["@type"];
        return Array.isArray(type) ? type.includes("JobPosting") : type === "JobPosting";
      });
      if (!posting) continue;

      const org = posting.hiringOrganization;
      const loc = [].concat(posting.jobLocation || []).filter(Boolean)[0];
      const address = loc?.address || {};
      const salary = posting.baseSalary?.value;

      return {
        title: String(posting.title || "").trim(),
        company: String(org?.name || org || "").trim(),
        location:
          posting.jobLocationType === "TELECOMMUTE"
            ? "Remote"
            : [address.addressLocality, address.addressRegion, address.addressCountry]
                .filter(Boolean)
                .join(", "),
        description: htmlToText(posting.description || ""),
        salary: salary
          ? [salary.minValue, salary.maxValue].filter(Boolean).join("–") +
            ` ${posting.baseSalary.currency || ""} ${salary.unitText || ""}`.trimEnd()
          : "",
      };
    }
    return null;
  }

  /* ---------------------------------------------------------------- */
  /* Site adapters                                                     */
  /* ---------------------------------------------------------------- */

  const SITES = {
    linkedin: {
      test: (url) => url.includes("linkedin.com"),
      isDetail: (url) => /\/jobs\/(view|collections|search)/.test(url) || /currentJobId=/.test(url),
      jobId: (url) =>
        url.match(/\/jobs\/view\/(\d+)/)?.[1] || new URL(url).searchParams.get("currentJobId") || "",
      extract: () => ({
        title: pick([
          ".job-details-jobs-unified-top-card__job-title",
          ".jobs-unified-top-card__job-title",
          ".top-card-layout__title",
          "h1",
        ]),
        company: pick([
          ".job-details-jobs-unified-top-card__company-name",
          ".jobs-unified-top-card__company-name",
          ".topcard__org-name-link",
        ]),
        location: pick([
          ".job-details-jobs-unified-top-card__primary-description-container span.tvm__text",
          ".jobs-unified-top-card__bullet",
          ".topcard__flavor--bullet",
        ]),
        salary: pick([".jobs-salary-main-rail-card", ".compensation__salary"]),
        description: pickRich([
          "#job-details",
          ".jobs-description__content",
          ".jobs-box__html-content",
          ".show-more-less-html__markup",
          ".description__text",
        ]),
      }),
      listings: () =>
        document.querySelectorAll(
          "li.scaffold-layout__list-item, li.jobs-search-results__list-item, div.job-card-container, li.jobs-search-result-item",
        ),
      listingData: (card) => ({
        jobId: card.querySelector("[data-job-id]")?.getAttribute("data-job-id") || "",
        title: pick([".job-card-list__title--link", ".job-card-list__title", "a.job-card-container__link", "strong"], card),
        company: pick([".artdeco-entity-lockup__subtitle", ".job-card-container__primary-description"], card),
        location: pick([".job-card-container__metadata-wrapper", ".job-card-container__metadata-item"], card),
        snippet: text(card).slice(0, 600),
      }),
    },

    naukri: {
      test: (url) => url.includes("naukri.com"),
      isDetail: (url) => /job-listings|\/jobs\/|jobId=/.test(url),
      jobId: (url) => url.match(/-(\d{6,})(?:\?|$)/)?.[1] || new URL(url).searchParams.get("jobId") || "",
      extract: () => ({
        title: pick([".styles_jd-header-title__rZwM1", ".jd-header-title", "h1"]),
        company: pick([".styles_jd-header-comp-name__MvqAI a", ".jd-header-comp-name a", ".comp-name"]),
        location: pick([".styles_jhc__location__W_pVs", "[class*='jhc__loc']", ".loc", ".locWdth"]),
        salary: pick(["[class*='jhc__salary']", ".salary", ".sal"]),
        description: pickRich([
          ".styles_JDC__dang-inner-html__h0K4t",
          "[class*='JDC__dang-inner-html']",
          ".dang-inner-html",
          ".job-desc",
          "section.job-desc",
        ]),
      }),
      listings: () =>
        document.querySelectorAll("div.srp-jobtuple-wrapper, article.jobTuple, div.jobTuple, div.cust-job-tuple"),
      listingData: (card) => ({
        jobId: card.getAttribute("data-job-id") || "",
        title: pick(["a.title", ".title"], card),
        company: pick(["a.comp-name", ".comp-name", ".subTitle"], card),
        location: pick(["span.locWdth", ".loc", "[class*='loc']"], card),
        snippet: text(card).slice(0, 600),
      }),
    },

    indeed: {
      test: (url) => url.includes("indeed.com"),
      isDetail: (url) => /viewjob|\/jobs\?/.test(url) || /[?&]vjk=/.test(url),
      jobId: (url) => {
        const params = new URL(url).searchParams;
        return params.get("jk") || params.get("vjk") || "";
      },
      extract: () => ({
        title: pick([
          "h2[data-testid='jobsearch-JobInfoHeader-title']",
          ".jobsearch-JobInfoHeader-title",
          "h1",
        ]),
        company: pick([
          "[data-testid='inlineHeader-companyName']",
          "[data-company-name]",
          ".jobsearch-CompanyInfoContainer a",
        ]),
        location: pick([
          "[data-testid='inlineHeader-companyLocation']",
          "[data-testid='job-location']",
          ".jobsearch-JobInfoHeader-subtitle div",
        ]),
        salary: pick(["#salaryInfoAndJobType", "[data-testid='attribute_snippet_testid']"]),
        description: pickRich(["#jobDescriptionText", ".jobsearch-JobComponent-description"]),
      }),
      listings: () => document.querySelectorAll("div.job_seen_beacon, td.resultContent, div.cardOutline"),
      listingData: (card) => ({
        jobId: card.querySelector("[data-jk]")?.getAttribute("data-jk") || "",
        title: pick(["h2.jobTitle span", "h2.jobTitle", ".jcs-JobTitle"], card),
        company: pick(["[data-testid='company-name']", ".companyName"], card),
        location: pick(["[data-testid='text-location']", ".companyLocation"], card),
        snippet: text(card).slice(0, 600),
      }),
    },
  };

  function currentSite() {
    const url = location.href;
    for (const [name, spec] of Object.entries(SITES)) {
      if (spec.test(url)) return { name, spec };
    }
    return { name: new URL(url).hostname, spec: null };
  }

  /* ---------------------------------------------------------------- */
  /* Public API                                                        */
  /* ---------------------------------------------------------------- */

  function bodyFallback() {
    const root = document.querySelector("main, article, [role='main']") || document.body;
    return (root.innerText || "").trim();
  }

  function extract() {
    const { name, spec } = currentSite();
    const structured = jsonLd();
    const scraped = spec ? spec.extract() : {};

    // Field-by-field merge: prefer whichever source actually produced a value,
    // with JSON-LD winning for description (it isn't truncated by lazy render).
    const merged = {
      title: structured?.title || scraped.title || document.title.split(/[|\-–]/)[0].trim(),
      company: structured?.company || scraped.company || "",
      location: structured?.location || scraped.location || "",
      salary: structured?.salary || scraped.salary || "",
      description: "",
    };

    const candidates = [structured?.description, scraped.description].filter(Boolean);
    merged.description = candidates.sort((a, b) => b.length - a.length)[0] || "";
    if (merged.description.length < 200) {
      const fallback = bodyFallback();
      if (fallback.length > merged.description.length) merged.description = fallback;
    }

    merged.description = merged.description.slice(0, MAX_DESCRIPTION);
    merged.site = name;
    merged.url = location.href.split("#")[0];
    merged.jobId = spec ? spec.jobId(location.href) : "";
    return merged;
  }

  /** Is the current URL plausibly a job detail page? */
  function isDetailPage() {
    const { spec } = currentSite();
    return spec ? spec.isDetail(location.href) : Boolean(jsonLd());
  }

  /** Search-result cards on this page, with a stable ref per card. */
  function listings() {
    const { name, spec } = currentSite();
    if (!spec?.listings) return [];

    const out = [];
    let index = 0;
    for (const card of spec.listings()) {
      const data = spec.listingData(card);
      if (!data.title) continue;
      out.push({
        element: card,
        ref: `${name}:${data.jobId || `i${index}`}`,
        site: name,
        jobId: data.jobId,
        title: data.title,
        company: data.company,
        location: data.location,
        description: data.snippet,
        url: card.querySelector("a[href]")?.href || location.href,
      });
      index++;
    }
    return out;
  }

  /**
   * Resolve when the page has content worth extracting.
   * Job boards render the description asynchronously and a fixed timeout either
   * fires too early on a slow connection or wastes time on a fast one — so watch
   * the DOM until the description stops growing, with a hard ceiling.
   */
  function waitForContent({ timeout = 12000, settle = 600, minLength = 200 } = {}) {
    return new Promise((resolve) => {
      let best = 0;
      let settleTimer = null;
      let observer = null;

      const finish = () => {
        clearTimeout(settleTimer);
        clearTimeout(hardStop);
        observer?.disconnect();
        resolve(extract());
      };

      const check = () => {
        const length = extract().description.length;
        if (length <= best) return;
        best = length;
        clearTimeout(settleTimer);
        if (best >= minLength) settleTimer = setTimeout(finish, settle);
      };

      const hardStop = setTimeout(finish, timeout);
      observer = new MutationObserver(check);
      observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
      check();
    });
  }

  JFS.Extractors = { extract, isDetailPage, listings, waitForContent, currentSite };
})();
