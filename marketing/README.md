# VIVIM public marketing site

Canonical public landing-page source: [index.html](index.html). This is a standalone, dependency-free static HTML page, **not** a second application or the existing Studio runtime.

## Preview

Open `marketing/index.html` in a browser, or from the repository root run:

```sh
python -m http.server 8080 --directory marketing
```

Then visit `http://localhost:8080`. Requires Python only for HTTP preview; the HTML file itself can be opened directly.

## Deployment

Set the static site's publish/output directory to `marketing` in the chosen hosting service. No build command, secrets, provider logins or API required. Deploying and configuring a custom domain are **not** covered by this source commit. Do not point a production domain at it without checking copy, links and accessibility in a real browser.

## Content and trust contract

- Market the personal-world experience as **in development**, not a shipped finished product.
- Existing capture tooling is local-first, but provider interactions are network actions. Do not promise absolute security or complete provider conversation coverage.
- `docs/product/FIRST-USER-ONBOARDING-DECISIONS-2026-10-27.md` records parked account/onboarding/workspace decisions. Never market parked features as live.
- The illustrative world panel is a concept, not an actual product screenshot.
- CTAs currently point to real public GitHub destinations; there is **no** invented sign-up, billing, mailing-list or waitlist backend.
- No analytics, external font requests, scripts, trackers or third-party embeds.
- Editing owner: [Marketing Landing Agent](../.opencode/agents/marketing-landing.md).

## Acceptance checklist

- [x] Static HTML with inline CSS; no external dependencies.
- [x] Mobile breakpoint and reduced-motion handling.
- [x] Anchor navigation and keyboard focus visibility.
- [x] SEO title/description and social preview text.
- [x] Honest release-status and product concept labeling.
- [ ] Real-browser visual and accessibility inspection.
- [ ] Custom domain / production deployment configured.
