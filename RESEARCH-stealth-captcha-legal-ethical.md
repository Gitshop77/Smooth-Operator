# Stealth & CAPTCHA-Bypass in Browser Automation — Legal, Ethical & Responsible-Use Report

> **Scope:** Research briefing for a developer adding *stealth (anti-detection)* and *CAPTCHA-bypass* capabilities to an open-source Puppeteer-based MCP browser server.
>
> **Purpose:** Design responsibly — not to block the feature, but to scope it, gate it, and document it correctly.
>
> **Disclaimer:** This is a research summary, not legal advice. Jurisdiction and fact patterns matter enormously. Ship with a "consult counsel" note for commercial use.

---

## Executive Summary (the one-pager)

1. **The capability is legally dual-use.** The same techniques that let you test your own site's bot detection are the same ones scalpers and scrapers use against third parties. Courts and regulators are increasingly treating *circumventing a technical access control* as legally distinct from *just visiting a public page*.
2. **The key legal hinge is "access control" vs. "detection."**
   - **CFAA (US):** Scraping *public* data likely stays outside the CFAA even after access is revoked (*hiQ v. LinkedIn*, 9th Cir. 2022, reinforced by *Van Buren* 2021). But circumventing a *password/auth gate* is core CFAA territory. ToS breach alone is **not** CFAA (*Facebook v. Power Ventures*, 9th Cir. 2016).
   - **DMCA § 1201 (US):** A CAPTCHA that gates a *copyrighted work* is treated as an "access control technological measure." *Trafficking* in bypass tools can be liable (*Ticketmaster v. RMG* 2007; *Craigslist v. Naturemarket* 2010; *Reddit v. SerpApi* 2025). But a measure guarding only *non-copyrightable public facts* may **not** qualify (*Google v. SerpApi* 2026; *Ziff Davis v. OpenAI* 2025 — robots.txt is a "keep off the grass" sign, not a TPM).
3. **The safest default posture for a general-purpose server:** ship stealth and CAPTCHA-solving as **explicit, opt-in, well-documented profiles** with prominent disclaimers, polite defaults (rate limits, `robots.txt` awareness), a **human-in-the-loop** default for hard captchas, proxy/IP transparency, and audit logging. Keep the *default* browser behavior clean and detectable-ish; let the user opt into stealth.
4. **Industry norm is converging on "stealth for testing, bypass for abuse"** plus operator transparency (Web Bot Auth, verified-bot directories, `robots.txt` as identity). The trend rewards *disclosed, rate-limited, authenticated* automation over *invisible* automation.

---

## 1. Legal Landscape

### 1.1 CFAA (Computer Fraud and Abuse Act, 18 U.S.C. § 1030)

**What it prohibits:** accessing a "protected computer" *without authorization* or *exceeding authorized access*.

**The public-scraping precedent — *hiQ Labs v. LinkedIn* (9th Cir. 2019, reaffirmed 2022 after *Van Buren*):**
- hiQ scraped **public** LinkedIn profiles. LinkedIn sent a C&D citing CFAA, DMCA, CA Penal Code § 502(c), and trespass.
- The 9th Circuit held hiQ "raised serious questions" that scraping **publicly available** data is **not** "without authorization" under the CFAA — even after LinkedIn revoked access and blocked it.
- Core reasoning (the **"gates-up-or-down" test**, from SCOTUS *Van Buren v. United States*, 141 S. Ct. 1648 (2021)): the CFAA is an *anti-intrusion* statute analogous to "breaking and entering." Where access is **open to the general public** and no permission (e.g., password) is required, there are "no gates to lift or lower," so "without authorization" is inapt.
- **Practical takeaway:** *Circumventing detection* on a public page is legally much safer than *circumventing an access control*. The 9th Cir. explicitly frames the dividing line around **authentication** ("an authentication requirement, such as a password gate, is needed to create the necessary barrier").

**Circumventing access controls vs. evading detection — the distinction:**
| Action | Likely CFAA status |
|---|---|
| Visit a public page, no login | Outside CFAA (*hiQ*) |
| Evade a fingerprint/UA check on a public page | Likely outside CFAA (detection, not authorization) |
| Bypass a password/login wall | Core CFAA "without authorization" |
| Use stolen/another user's credentials | Not DMCA "circumvention" in some circuits (*Egilman v. Keller & Heckman*; *iSpot.tv v. Teyfukova*), but CFAA/contract risk remains |
| Layered measures (password **plus** IP whitelist/VPN bypass) | Plausible § 1201 circumvention (*CDK Global v. Tekion*, 2025) |

**ToS violations alone are not CFAA:** *Facebook, Inc. v. Power Ventures, Inc.*, 844 F.3d 1058 (9th Cir. 2016) — "a violation of the terms of use of a website—without more—cannot establish liability under the CFAA." This is the single most important limit on CFAA-as-scraping-weapon. (Note: circuit split exists — 1st Cir. *EF Cultural Travel*, 11th Cir. *Rodriguez* took a broader view, but *Van Buren* + *Nosal* narrowed it.)

**Caveats:** CFAA is not resolved — circuit split on "without authorization" persists; *hiQ* was only a *preliminary injunction* (never a merits judgment); other claims (tortious interference, trespass to chattels, copyright) survive. Trend: platforms are making **more** data auth-gated (*X Corp v. scrapers* 2023–2025), which shrinks the "public" safe zone.

### 1.2 DMCA Anti-Circumvention (17 U.S.C. § 1201) — the CAPTCHA angle

This is the **most direct legal risk for a stealth/CAPTCHA-bypass tool**, because § 1201 has a **"trafficking"** prong: it's not just *using* a bypass, it can be *making available / marketing* a device or service *primarily designed to circumvent*.

**CAPTCHA = "access control technological measure":**
- ***Ticketmaster, LLC v. RMG Technologies* (C.D. Cal. 2007):** RMG sold software letting customers bypass Ticketmaster's CAPTCHA to mass-buy tickets. Court: CAPTCHA "effectively controls access to a copyrighted work" (the ticket page); RMG likely liable under **§ 1201(a)(2)** (access-control trafficking) and **§ 1201(b)(1)** (rights protection trafficking). Also copyright infringement + breach of ToS.
- ***Craigslist, Inc. v. Naturemarket, Inc.* (N.D. Cal. 2010):** "CraigsList AutoPoster" with auto CAPTCHA-bypass → valid § 1201(a)(2) + (b)(1) claim.
- ***Reddit, Inc. v. SerpApi* (S.D.N.Y. 2025 — very recent, very relevant):** Reddit's **SearchGuard** (JS challenges + CAPTCHA + bot detection blocking scraping of Google SERPs) qualified as a "technological measure that effectively controls access" under **§ 1201(a)(3)(B)** — *even though the same content was available to human users*. Court's analogy: like "a facial-recognition technology programmed to open the door of a home for residents but not for other visitors." § 1201 does **not** require the copyright holder to have specifically authorized the *particular* measure — broad authorization suffices. Distinguished from Google's own case (see below).

**The counter-trend — when the guarded content is NOT copyrightable:**
- ***Google LLC v. SerpApi* (S.D.N.Y. Judge Gonzalez Rogers, July 2026):** Google's SearchGuard DMCA claims **dismissed**. Holding: Google Search results (URLs, snippets, factual index data) are **not copyrightable**, so SearchGuard is **not** a qualifying "technological protection measure." "A lock on a public noticeboard is not the same as a lock on a private library." (Left 21 days to amend on narrower grounds.)
- ***Ziff Davis, Inc. v. OpenAI* (S.D.N.Y. Dec. 2025):** robots.txt directives are **not** a § 1201 TPM — a "keep off the grass" sign does not "effectively control access," and merely *disregarding* robots.txt is not "circumvention." (Dismissed with prejudice.)

**Practical synthesis for your tool:**
- Bypassing a CAPTCHA that gates a **copyrighted work** (webpages, media) → **higher DMCA trafficking risk**, especially if you *market* the bypass.
- Bypassing a measure guarding only **non-copyrightable public facts** → risk is lower but **unresolved** (Google v. SerpApi cut both ways; Reddit v. SerpApi went the other way).
- **Trafficking** (shipping the capability in a widely-distributed open-source server) is the subtler exposure vs. a single end-user's use. The § 1201(a)(2) "primarily designed / marketed for circumvention" test is where a purpose-built bypass tool is most exposed.

### 1.3 GDPR / Privacy — fingerprinting and data collection

Stealth is not just about hiding *you*; it often involves *collecting* device/browser signals. Two-layer EU stack:

- **ePrivacy Directive (Art. 5(3)) — "the cookie law":** requires **prior consent** before "storing of information, or the gaining of access to information already stored, in the terminal equipment of a user." Technology-neutral → covers **device fingerprinting** (screen, fonts, audio, GPU, timezone, WebGL, canvas). **EDPB Guidelines 2/2023** (final Oct 2024) explicitly pulled fingerprinting, pixels, URL/IP tracking into scope.
- **GDPR (Art. 4(1), Recital 30):** a browser fingerprint that can **single out** a person is **personal data** — even without a name/email (*Article 29 Working Party Opinion 9/2014*; CJEU *Planet49*). Processing needs a lawful basis (usually **consent**; legitimate interest only for narrowly scoped anti-fraud after a balancing test).

**Enforcement signals:** CNIL v. Google (€150M in 2021; €325M in Sept 2025), CNIL v. Facebook Ireland (€60M, 2021) — "accept vs. reject parity" theory, directly applicable to fingerprinting consent UX. GDPR applies **extraterritorially** (Art. 3(2)) — a US-based server fingerprinting EU visitors is in scope.

**For your tool:** If your stealth/fingerprint features *read* device signals to build a profile (and especially if persisted/rotated/sold), that's processing of personal data in the EU. Consent/strictly-necessary-anti-fraud framing matters. Purely ephemeral local fingerprinting for a single test session is lower risk than persisted cross-site correlation.

### 1.4 Contract Law / Terms of Service

- ToS is a **contract** claim (not CFAA per *Power Ventures*). Breach-of-contract/trespass to chattels remain available where a scraper ignores explicit prohibitions (*Ticketmaster v. RMG* found ToS breach alongside DMCA).
- **Clickwrap vs. browsewrap:** enforced contracts (explicit "I agree") carry more weight than mere posted terms.
- **Key point:** stealth that lets you *continue after a Cease&Desist* or *after being banned* converts a "polite guest" into a "refused-but-still-entering" actor — which weakens any good-faith defense and is exactly the fact pattern courts dislike (*hiQ*'s LinkedIn C&D is the counter-example only because the data was public).

---

## 2. Ethical Framework — Dual-Use

The techniques are **ethically neutral**; intent + target + impact determine legitimacy.

**Legitimate (low ethical concern):**
- Testing **your own** sites' bot detection / CAPTCHA UX.
- **Accessibility** automation (verifying screen readers, form flows for disabled users).
- **QA / integration testing** of your own or licensed products.
- **Your own automation** of services you have a right to use (price tracking of products you buy, personal scripting).
- Academic/journalistic research on **public** data with politeness.

**Problematic (high ethical/legal concern):**
- Scraping **protected/third-party** sites **at scale** after they asked you to stop.
- **Fraud:** fake account creation, loyalty-program abuse, fake reviews.
- **Scalping / inventory hoarding** (exactly what *Ticketmaster v. RMG* was about — beating humans to tickets).
- **Defeating anti-bot on sites where you have no relationship** to harvest data for a competing product.
- **Circumventing paywalls / auth** you're not entitled to.

**The ethical test your tool should encode:**
1. **Authorization** — did the site grant access, or revoke it?
2. **Copyrightability / sensitivity** — public facts vs. copyrighted/personal data?
3. **Impact** — does the traffic harm the site or disserve real users (scalping)?
4. **Consent & transparency** — is automation disclosed and rate-limited?
5. **Purpose** — own-system testing vs. third-party extraction for advantage?

A well-designed tool makes the *legitimate path the default* and requires affirmative steps + acknowledgment for the *aggressive path*.

---

## 3. Responsible-Use Design Patterns

### 3.1 Opt-in / feature-flagged (default OFF)
- **Stealth profile** and **CAPTCHA solver** should be **explicitly enabled**, not active by default.
- Config surface: env vars / `--config` JSON flags (e.g., `SMOOTH_OPERATOR_STEALTH=off|minimal|aggressive`, `SMOOTH_OPERATOR_CAPTCHA_SOLVER=off|human|provider`), mirroring your existing `SMOOTH_OPERATOR_ALLOW_EVAL` gating model.
- Enabling should require an **explicit acknowledgment** (documented warning, possibly a second flag) that these are "aggressive automation" features.

### 3.2 Rate limiting & politeness
- **`robots.txt` awareness:** respect `Disallow` / `Crawl-delay` where feasible. (Note: *Ziff Davis* says robots.txt isn't a DMCA TPM, but it's strong evidence of site intent and matters for TTC/contract/good-faith.)
- **Per-domain throttling**, configurable min delay, concurrency caps, off-peak scheduling.
- **Back-off on 429/503** — reduce rate immediately on signals of distress.
- **One context per site**; keep per-domain proxy/timezone/UA coherence (per Browserless guardrails).

### 3.3 Clear documentation & warnings
- Prominent README section: "Stealth & CAPTCHA bypass are dual-use. You are responsible for compliance with CFAA, DMCA, GDPR, and each site's ToS."
- In-tool notices when a stealth/solver profile is active (log line, capability field).
- Map each capability to its legal risk tier (see §1).

### 3.4 Human-in-the-loop for sensitive captchas
- **Default:** route hard/ambiguous captchas (reCAPTCHA/hCaptcha identity checks, "I'm not a robot" widgets) to a **human solver** or pause for user input — not an automated OCR/model.
- Provider solvers (2Captcha/Anti-Captcha/CapSolver) are *human-or-AI* backends; expose as **opt-in with provider key**, and log that a third party received the challenge.
- Reserve fully-automated solving for **your own test sites** or clearly public, low-sensitivity flows.

### 3.5 Proxy / IP transparency
- Avoid **deceptively masking datacenter origin** as residential when targeting third parties (a key abuse signal).
- Where proxies are used, keep them **configured by the user**, logged, and coherent per domain.
- Consider exposing a "verified identity" posture (see §6) rather than pure anonymity.

### 3.6 Audit logging
- Log: target domain, profile used (stealth level, solver enabled), request rate, proxy origin, timestamp, captcha types encountered, rate-limit events.
- Serves compliance, incident investigation, and "proof of homework" if practices are questioned (industry best practice per Bright Data / Pitt guides).
- **Redact PII** from logs/artifacts (Browserless explicitly lists this).

---

## 4. Industry Conventions

**How the major tools frame responsible use:**

| Tool | Convention / default |
|---|---|
| **Scrapy** | Ships `ROBOTSTXT_OBEY = False` but docs *strongly* recommend setting it `True`; emphasize setting a descriptive `USER_AGENT` ("Crawl responsibly by identifying yourself"). |
| **Playwright** | Docs repeatedly: "respect robots.txt and terms of service," "do not overload servers," "use throttling and rate limiting," "comply with GDPR/CCPA." |
| **Puppeteer** | Core library is neutral; the *stealth* ecosystem lives in third parties (`puppeteer-extra-plugin-stealth`). |
| **browserless / Scrappey (Patchright)** | Publish **stealth routes** + explicit "legal and operational guardrails": respect robots/terms, rate-limit by domain, **don't impersonate privileged crawlers (avoid fake Googlebot)**, redact PII, safe credential handling. |
| **Patchright / nodriver / rebrowser** | ToS boilerplate: "Users are solely responsible for ensuring their use complies with applicable laws and the terms of service of any websites they interact with." |
| **2Captcha / solver APIs** | ToS: prohibited for illegal actions; "intended to support lawful access to publicly available information"; oppose collection of restricted/sensitive data without legal basis. |

**The "stealth for testing" vs "bypass for abuse" norm:**
- The mainstream framing treats fingerprint/UA patching as **legitimate for testing your own apps and for reliability** (matching a realistic browser), while *purpose-built circumvention of third-party anti-bot* for extraction/fraud is the abuse case.
- **Notable cautionary tale:** `puppeteer-extra-plugin-stealth` (berstend) is the ubiquitous "one-liner" stealth package — MIT, widely bundled — precisely because it's easy to reach for. Its maintenance limbo (maintainer MIA, 200+ open issues, 780+ dormant forks) shows the ecosystem's ambivalence: ubiquitous, lightly maintained, and predominantly used against third-party detection. **Design lesson:** make the *default* clean and the *stealth* an explicit, reviewed choice; document the cat-and-mouse reality (see below).

**Technical reality to document (managing expectations):**
- In-page stealth patches (`navigator.webdriver`, missing `window.chrome`, headless WebGL, UA) cover the *classic* signals and still work on simple/mid-tier sites.
- Modern anti-bot (Cloudflare, DataDome, PerimeterX) detects at the **CDP layer** (`Runtime.enable` leak) and behaviorally — in-page patches can't close that. Stealth is a **reliability/obfuscation** tool, not an invincibility switch. Document this honestly so users don't over-rely on it to abuse targets.

---

## 5. Recommendations for This MCP

Given it's a **general-purpose automation server** (not a single-target scraper), the default posture should be **conservative and opt-in**, with the aggressive capabilities clearly gated and documented.

**Ship-by-default guardrails:**
1. **Stealth = opt-in profile.** Default `off` (or `minimal`). Levels: `off` / `minimal` (hide only `navigator.webdriver`, headless UA — the "testing" baseline) / `full` (explicit opt-in with acknowledgment).
2. **CAPTCHA solver = explicit opt-in with provider config.** Default `human` (pause / external solver) or `off`. Provider-solver requires a user-supplied key, logged, and gated behind the same acknowledgment as stealth. Never ship a bundled key or auto-enroll.
3. **Prominent notices.** When stealth/solver is active, surface it in `server_health`/capabilities and logs. Ship a top-level "Responsible Use" doc + in-config warnings.
4. **Politeness by default.** `robots.txt` awareness, configurable rate limits/concurrency, auto back-off on 429/503, one context per domain. Make aggressive pacing part of the `full` stealth profile, not the default.
5. **Human-in-the-loop default** for identity captchas; automated solving as a named, keyed, logged opt-in.
6. **Proxy/IP transparency.** User-configured proxies only; log origin; discourage deceptive datacenter-as-residential masking; prefer a "verified identity" posture over pure stealth.
7. **Audit logging.** Domain, profile, rate, proxy origin, captcha events, rate-limit events; redact PII.
8. **Policy re-check at the service layer** (mirrors your existing `policy.ts` model): allowed/blocked domains, private/link-local blocking — re-validated even when stealth is on.
9. **Legal disclaimer in packaging/README:** dual-use; user responsible for CFAA/DMCA/GDPR/ToS compliance; consult counsel for commercial/scale use.
10. **Capability gating parity:** treat stealth/solver like your existing `browser_evaluate` (off by default, gated behind a flag) — same mental model for users.

**Risk-tiering table for the doc:**

| Capability | Default | Primary legal exposure if abused |
|---|---|---|
| Basic automation (no stealth) | on | CFAA (if auth-gated), ToS |
| Stealth (hide automation) | off/opt-in | Weakens good-faith defense; DMCA trafficking if purpose-built bypass |
| CAPTCHA auto-solve | off/human | DMCA § 1201 (if gated work); ToS; fraud/scalping |
| Proxy rotation | user-config | IP reputation/ToS; transparency |
| Fingerprint read/persist | minimal | GDPR/ePrivacy consent |

---

## 6. Attribution & Transparency

**The trend is toward *disclosed, authenticated* automation, not *invisible* automation.**

- **Web Bot Auth (IETF draft, chartered WG 2026):** Ed25519-signed HTTP requests + a published JWKS at `/.well-known/...` so sites know *who* the bot is and *why*. Backed by Cloudflare, Akamai, AWS. Signals a future where "signed, identified agents" get a privileged lane and **unsigned/stealth traffic is treated more strictly by default**.
- **Verified-bot directories** (Cloudflare Verified Bots, Akamai Bot Manager, KnownAgents): identity + categorization drive allow/block/rate-limit decisions.
- **EU AI Act (Art. 50, enforceable Aug 2026):** systems interacting with humans must **disclose** they are automated; AI-generated content must be labeled. Directly relevant to an agent-driven browser.
- **FTC bot-disclosure pressure** and "bot disclosure mandates (digital identification for crawlers)" are cited as the next regulatory step.
- **robots.txt as identity:** rather than a mere "keep off the grass" sign, the emerging model treats a crawler's published identity/compliance as a trust signal.

**Recommendation:** even when stealth is enabled, consider exposing a **stable, honest operator identity** (a `User-Agent`/`Signature-Agent`-style token, a contact/crawler-info endpoint, `robots.txt`-style self-disclosure). The market and regulators are rewarding *verifiable, rate-limited, disclosed* automation; the long-run sustainable model is "known agent," not "invisible bot."

---

## Appendix — Key Cases & Sources

**CFAA / scraping**
- *hiQ Labs, Inc. v. LinkedIn Corp.*, 938 F.3d 985 (9th Cir. 2019); No. 17-16783 (9th Cir. Apr. 18, 2022) — public scraping likely outside CFAA, post-*Van Buren*.
- *Van Buren v. United States*, 141 S. Ct. 1648 (2021) — "gates-up-or-down" anti-intrusion reading.
- *United States v. Nosal (Nosal II)*, 844 F.3d 1024 (9th Cir. 2016).
- *Facebook, Inc. v. Power Ventures, Inc.*, 844 F.3d 1058 (9th Cir. 2016) — ToS breach ≠ CFAA.

**DMCA / CAPTCHA bypass**
- *Ticketmaster, LLC v. RMG Technologies, Inc.*, 507 F. Supp. 2d 1096 (C.D. Cal. 2007) — CAPTCHA = access-control TPM; bypass tool = § 1201 trafficking.
- *Craigslist, Inc. v. Naturemarket, Inc.*, 694 F. Supp. 2d 1039 (N.D. Cal. 2010).
- *Reddit, Inc. v. SerpApi LLC* (S.D.N.Y. 2025) — SearchGuard (CAPTCHA+JS+bot-detect) = access control measure, even with human-accessible content.
- *Google LLC v. SerpApi* (S.D.N.Y. July 20, 2026) — results not copyrightable → SearchGuard not a TPM.
- *Ziff Davis, Inc. v. OpenAI* (S.D.N.Y. Dec. 15, 2025) — robots.txt is not a § 1201 TPM ("keep off the grass").
- *CDK Global LLC v. Tekion* (2025) — layered auth+IP measures can be § 1201 circumvention.

**Privacy / fingerprinting**
- GDPR Art. 4(1), Recital 30; ePrivacy Directive Art. 5(3); EDPB Guidelines 2/2023; Art. 29 WP Opinion 9/2014.
- CNIL v. Google (€150M, 2021; €325M, Sept 2025); CNIL v. Facebook Ireland (€60M, 2021); CJEU *Planet49*, *Orange Romania*, *Meta v. Bundeskartellamt*.

**Industry / transparency**
- Scrapy docs (`ROBOTSTXT_OBEY`, `USER_AGENT`); Playwright/Puppeteer scraping guides.
- Browserless "Stealth" + guardrails docs; Patchright/nodriver/rebrowser ToS.
- 2Captcha/Anti-Captcha ToS.
- Web Bot Auth IETF draft (draft-meunier-web-bot-auth-architecture); Imperva 2026 Bad Bot Report (53% bot traffic); EU AI Act Art. 50.

---

*Compiled for responsible feature design. Verify current status per jurisdiction before shipping; this summary reflects case law and guidance as of the research date and is not legal advice.*
