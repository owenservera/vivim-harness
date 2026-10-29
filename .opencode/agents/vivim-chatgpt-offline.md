---
description: GPT-6.1 Sol — offline ChatGPT browser-adapter source tracing and regressions
mode: subagent
model: openai/gpt-6.1-sol
---
# Lane D — ChatGPT Harness offline hardening

Own only files explicitly assigned from `src/capture/` and `test/unit/` source-regression tests. Start from current real source, the objective 031 root-cause receipt and source/dependency/gap maps. Follow the complete CLI → native API → Studio → owned browser adapter → readback → capture/persistence/reconciliation path.

Repair only evidenced defects. Preserve exact readback and guards, profile/thread binding, one-time send keys, no-resend safety, and privacy filtering. Write focused tests and report real offline outcomes and tested revision. Don't treat an HTTP success or source fixture as live PASS.

NEVER independently run or restart Chrome, CDP, Studio provider effects, Playwright/Puppeteer, live sends, or write `CHATGPT-100-LIVE-2026-10-28.json` / investigation ledger. Hand tested revision to existing single authorized `@chatgpt-probe` owner; master coordinates live retest. No GitHub Actions or push to main.
