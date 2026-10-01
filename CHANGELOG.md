# Changelog

All notable changes to this project will be documented in this file.

## 0.1.7 - 2026-10-01

- Retired model removed: `cline-free/gemini-3.8-flash` (dropped from the gateway's free tier)
- Free-route client headers track the latest CLI release

## 0.1.6 - 2026-09-25

- New free models: `cline-free/gemini-3.8-flash` (mandatory low/medium/high reasoning), `stealth/space-bunny-alpha`, `cline-free/mimo-v2.6-flash`, and `cline-free/deepseek-v4.1-flash`
- New paid model: `cline-pass/muse-spark-1.3-contributor` ($0.10/$0.20/$0.01)
- Retired models removed from catalog
- Error classification refined: upstream provider errors, 402 (insufficient credits), 404 (model not found), and 5xx gateway errors no longer misclassified as expired auth
- Free-route client headers updated to latest CLI convention

## 0.1.4 - 2026-09-09

- New free model: `cline-free/solar-pro4` and `cline-free/muse-spark-1.3-contributor`

## 0.1.3 - 2026-08-31

- Corrected model input modalities: `glm-5.3` and `deepseek-v4-flash` are text-only, `mimo-v2.5` and `qwen3.8-max` accept images

## 0.1.2 - 2026-08-30

- New paid model: `cline-pass/glm-5.3-flash` ($0.15/$0.50/$0.03)
- New free model: `cline-free/longcat-2.0`
- Model picker shows prices
- Price calibration via `/clinepass` measures real billing and updates the whole panel; fatal errors abort the run
- `/clinepass` runs in a centered modal: dashboard (prices, plan sidebar) and calibration (live per-model progress, esc-esc cancel)
- Prices stored in `clinepass-prices.json`, seeded on install, synced per release
- Gateway thinking-stream corruption repaired
- pi's built-in cost estimate off for ClinePass (the footer meter is the single cost display, turn cost includes every tool-calling round)
- Free-route headers applied to every free model
- 403 on free routes classified as route gate, not subscription

## 0.1.1 - 2026-08-27

- Catalog: `stealth/ox-alpha` is now `z-ai/glm-5.3-flash` (renamed)
- Context capped to 921600 for 1M models to avoid gateway edge
- Max output capped to 131072 for code-friendly limits
- Inputs updated per modalities (image where supported)
- Thinking levels mapped per model spec
- Prices adjusted to latest measured rates

## 0.1.0 - 2026-08-26

- Initial release
- 16 models (13 paid, 3 free)
- Server-truth billing meter and plan report
- Login via Cline CLI, browser, or API key
