/**
 * The /clinepass modal views, rendered via ctx.ui.custom() with overlay mode.
 *
 * Both dialogs share one design language:
 *   - a bordered box centered over the terminal (width 90%, capped at 80% of
 *     its height, so the footer never clips),
 *   - content on the left, action hints right-anchored on the footer row,
 *   - wide terminals get two columns (main list left, sidebar right); narrow
 *     terminals fall back to a single scrolling column.
 *
 * Two-column rows lay out like a document: the modal box hugs its content
 * (the overlay sizes it from the view's `width`), each column keeps its
 * natural width, and every line of text is LEFT-aligned behind a fixed
 * inset — the block sits centered on the terminal, the words read from the
 * left like on a page. The box always fills `inner` exactly, so a row longer
 * than the box can never punch through the border.
 */

import { Key, matchesKey, truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import type { CapReportData } from "./usage.js";
import type { CalProgress, CalRow } from "./calibrate.js";

/** Minimal structural shape of pi's theme object. */
export interface ViewTheme {
  fg: (color: string, text: string) => string;
  bold: (text: string) => string;
}

/** Total lines a modal may occupy — matches the overlay's maxHeight ("90%"). */
function lineBudget(tui: TUI): number {
  return Math.max(10, Math.floor((tui.terminal?.rows ?? 24) * 0.9));
}

/** Truncate to width and pad to width (ANSI-aware). */
const padTo = (line: string, width: number): string => {
  const text = truncateToWidth(line, width);
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
};

/** Gap on each side of the column separator (report page). */
const COL_GAP = 3;

/** The report (dashboard) page: uniform spacing — symmetric margins and the
 * same breathing room around the separator, matching the calibration page. */
const RPT_MARGIN = 3;

/**
 * One two-column row's bare content (render() adds the box borders): columns
 * at their NATURAL widths, every cell's text left-aligned behind the
 * document margin — like text on a page, not centered lines. Each view owns
 * its spacing: the outer margins are always symmetric, and the breathing
 * room around the separator is its own (a touch wider than the margins).
 */
function twoColRow(
  left: string,
  leftW: number,
  sep: string,
  right: string,
  rightW: number,
  gap: number,
  margin: number,
): string {
  const inset = " ".repeat(margin);
  const gapSpaces = " ".repeat(gap);
  return `${inset}${padTo(left, leftW)}${gapSpaces} ${sep} ${gapSpaces}${padTo(right, rightW)}${inset}`;
}

// ─── Calibration progress modal ────────────────────────────────────────────

/** Column width — both columns are IDENTICAL; long probe details truncate
 * here on either side. */
const CAL_COL_W = 50;
/** Symmetric outer margins of the calibration page. */
const CAL_MARGIN = 3;
/** Breathing room around the separator — the SAME as the outer margins,
 * per the reference layout: only the name→detail gap inside a row breathes. */
const CAL_GAP = 3;
/** Width of one bare two-column row. */
const CAL_ROW_W = 2 * CAL_MARGIN + 2 * CAL_COL_W + 2 * CAL_GAP + 3;
/** Minimum inner width for the two-column split (the row must fit whole). */
const CAL_TWO_COL_MIN = CAL_ROW_W;

export class CalibrationView {
  private progress?: CalProgress;
  private summary?: string;
  private summaryIsError = false;
  private phase: "running" | "winding" | "done" = "running";
  private armed = false;
  private armedAt = 0;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(
    private tui: TUI,
    private theme: ViewTheme,
    private opts: { onCancel: () => void; onClose: () => void },
  ) {}

  /** Natural box width (row content + the border/padding) — the overlay
   * sizes the modal from this, so the box hugs its content. */
  get width(): number {
    return CAL_ROW_W + 4;
  }

  update(progress: CalProgress): void {
    this.progress = progress;
    this.refresh();
  }

  /** The run ended (finished or cancelled): show the summary, wait for a key. */
  finish(summary: string, isError = false): void {
    this.phase = "done";
    this.summary = summary;
    this.summaryIsError = isError;
    this.armed = false;
    this.refresh();
  }

  private refresh(): void {
    this.invalidate();
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (this.phase === "done") {
      this.opts.onClose();
      return;
    }
    if (this.phase === "winding") return;
    if (matchesKey(data, Key.escape)) {
      // Double-escape within 3s confirms; a stray escape just arms.
      if (this.armed && Date.now() - this.armedAt < 3000) {
        this.phase = "winding";
        this.opts.onCancel();
        this.refresh();
      } else {
        this.armed = true;
        this.armedAt = Date.now();
        this.refresh();
      }
    }
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const t = this.theme;
    const inner = Math.max(24, width - 4);
    const p = this.progress;
    const rows = p?.rows ?? [];
    const half = Math.ceil(rows.length / 2);
    const twoCol = inner >= CAL_TWO_COL_MIN && half <= lineBudget(this.tui) - 6;

    // Header row: title left, running spend right.
    const spent = p && p.spentUsd > 0 ? t.fg("muted", `$${p.spentUsd.toFixed(4)} spent`) : "";
    const title = t.bold(`ClinePass Calibration — ${p ? `${p.done}/${p.total}` : "…"}`);
    const header = spent
      ? `${padTo(title, inner - visibleWidth(spent) - 1)} ${spent}`
      : padTo(title, inner);

    const lines = [
      `┌${"─".repeat(inner + 2)}┐`,
      `│ ${header} │`,
      `│ ${" ".repeat(inner)} │`,
      ...this.body(rows, half, twoCol).map((l) => `│ ${padTo(l, inner)} │`),
      `│ ${" ".repeat(inner)} │`,
      this.footerRow(inner),
      `└${"─".repeat(inner + 2)}┘`,
    ];
    this.cachedLines = lines;
    this.cachedWidth = width;
    return lines;
  }

  /** Content rows: models in queue order — down the left column (1..half),
   * then down the right (half+1..end); both columns are the same fixed width
   * and every row starts at the same document inset, so a column of short
   * names lines up exactly like the detail-heavy one. Narrow terminals get a
   * single frontier window instead. */
  private body(rows: readonly CalRow[], half: number, twoCol: boolean): string[] {
    if (rows.length === 0) return [];
    const sep = this.theme.fg("dim", "│");
    if (twoCol) {
      const leftRows = rows.slice(0, half).map((r) => this.renderRow(r));
      const rightRows = rows.slice(half).map((r) => this.renderRow(r));
      const lines: string[] = [];
      for (let i = 0; i < half; i++) {
        lines.push(twoColRow(leftRows[i]!, CAL_COL_W, sep, rightRows[i] ?? "", CAL_COL_W, CAL_GAP, CAL_MARGIN));
      }
      return lines;
    }
    const budget = Math.max(4, lineBudget(this.tui) - 8);
    let focus = rows.findIndex((r) => r.state !== "done");
    if (focus < 0 || rows.length - focus < budget) focus = Math.max(0, rows.length - budget);
    const lines: string[] = [];
    if (focus > 0) lines.push(this.theme.fg("dim", `… ${focus} done above`));
    for (const row of rows.slice(focus, focus + budget)) lines.push(this.renderRow(row));
    return lines;
  }

  /** Footer: status note left, action right. */
  private footerRow(inner: number): string {
    const t = this.theme;
    let action: string;
    if (this.phase === "done") action = t.fg("dim", "press any key to close");
    else if (this.phase === "winding") action = "";
    else if (this.armed) action = t.fg("warning", "esc again to cancel (3s)");
    else action = t.fg("dim", "[esc] cancel");

    let note: string;
    if (this.phase === "done") {
      note = this.summary ? (this.summaryIsError ? t.fg("error", this.summary) : t.fg("success", this.summary)) : "";
    } else if (this.phase === "winding") {
      note = t.fg("warning", "cancelling…");
    } else {
      const inflight = (this.progress?.rows ?? []).filter((r) => r.state === "running").length;
      note = t.fg("muted", inflight > 0 ? `… ${inflight} in flight` : "…");
    }
    return `│ ${padTo(note, inner - visibleWidth(action) - 1)} ${action} │`;
  }

  private renderRow(row: CalRow): string {
    const t = this.theme;
    // Icon + name (aligned to a fixed label width) + a two-space gap before
    // the detail — the detail must breathe from the model, not touch it.
    const label = row.name.padEnd(18);
    const detail = row.detail ? `  ${row.detail}` : "";
    switch (row.state) {
      case "queued":
        return t.fg("dim", `· ${label}`);
      case "running":
        return t.fg("dim", `… ${label}${detail}`);
      case "done":
        return t.fg("success", `✓ ${label}${detail}`);
      case "failed":
        return t.fg("error", `✗ ${label}${detail}`);
    }
  }
}

// ─── Dashboard report modal ──────────────────────────────────────────────────

const METER_MIN = 40;

export class ReportView {
  private top = 0;
  /** Inner width of the last render — handleInput needs it to clamp scroll. */
  private lastInner = 80;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(
    private tui: TUI,
    private theme: ViewTheme,
    private data: CapReportData,
    private onClose: () => void,
  ) {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.return)) {
      this.onClose();
      return;
    }
    let delta = 0;
    if (matchesKey(data, Key.up) || data === "k") delta = -1;
    else if (matchesKey(data, Key.down) || data === "j") delta = 1;
    else if (matchesKey(data, Key.pageUp)) delta = -10;
    else if (matchesKey(data, Key.pageDown)) delta = 10;
    if (delta !== 0) {
      this.top = Math.max(0, Math.min(this.scrollMax(), this.top + delta));
      this.cachedLines = undefined;
      this.tui.requestRender();
    }
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }

  /** The price table's exact width (header/rows/dividers all match it). */
  private priceW(): number {
    return this.data.priceTableW;
  }

  /** Width of the bare two-column row (margins + columns + separator spaces). */
  private rowWidth(): number {
    return 2 * RPT_MARGIN + this.meterW() + 2 * COL_GAP + 3 + this.priceW();
  }

  /** Natural box width (row content + the border/padding) — the overlay
   * sizes the modal from this, so the box hugs its content instead of
   * stretching to the terminal. */
  get width(): number {
    return this.rowWidth() + 4;
  }

  /** Two columns only when the (possibly terminal-clamped) inner width still
   * holds the natural split — below that, stacking beats truncating. */
  private twoColFor(inner: number): boolean {
    return inner >= this.rowWidth();
  }

  private meterW(): number {
    return Math.max(METER_MIN, ...this.data.meter.map((l) => visibleWidth(l)));
  }

  /** How far the window may scroll: the price column in two-column mode, the
   * whole body when stacked. */
  private scrollMax(): number {
    const budget = Math.max(8, lineBudget(this.tui) - 8);
    const len = this.twoColFor(this.lastInner) ? this.priceColumn().length : this.stackedBody().length;
    return Math.max(0, len - budget);
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) return this.cachedLines;
    const t = this.theme;
    const inner = Math.max(24, width - 4);
    this.lastInner = inner;
    const budget = Math.max(8, lineBudget(this.tui) - 8);

    const lines: string[] = [
      `┌${"─".repeat(inner + 2)}┐`,
    ];
    // No banner title: each block carries its own heading (the plan line heads
    // the meter, the column row heads the price table).

    let scrollable = false;
    if (this.twoColFor(inner)) {
      const prices = this.priceColumn();
      const maxTop = Math.max(0, prices.length - budget);
      this.top = Math.min(this.top, maxTop);
      scrollable = prices.length > budget;
      const window = prices.slice(this.top, this.top + budget);
      const sep = t.fg("dim", "│");
      const colLeft = this.meterW();
      const colRight = this.priceW();
      // The meter block keeps its document grouping (plan/active, blank line,
      // then each limit separated by a blank) and is centered vertically in
      // its half — a paginated sidebar beside the scrolling table.
      const meter = this.data.meter;
      const height = Math.max(Math.min(prices.length, budget), meter.length);
      const offset = Math.floor((height - meter.length) / 2);
      for (let i = 0; i < height; i++) {
        const m = i >= offset ? (meter[i - offset] ?? "") : "";
        const p = i < window.length ? window[i] : "";
        lines.push(`│ ${padTo(twoColRow(m, colLeft, sep, p, colRight, COL_GAP, RPT_MARGIN), inner)} │`);
      }
    } else {
      const body = this.stackedBody();
      const maxTop = Math.max(0, body.length - budget);
      this.top = Math.min(this.top, maxTop);
      scrollable = body.length > budget;
      for (const l of body.slice(this.top, this.top + budget)) lines.push(`│ ${padTo(l, inner)} │`);
    }
    // A blank row keeps the footer off the content above it.
    lines.push(`│ ${" ".repeat(inner)} │`);
    const hint = scrollable ? t.fg("dim", "↑/↓ scroll · [esc] close") : t.fg("dim", "[esc] close");
    lines.push(`│ ${padTo("", inner - visibleWidth(hint) - 1)} ${hint} │`);
    lines.push(`└${"─".repeat(inner + 2)}┘`);
    this.cachedLines = lines;
    this.cachedWidth = width;
    return lines;
  }

  /** The price column: its own title, header, rows — it scrolls as one. */
  private priceColumn(): string[] {
    return [
      this.theme.bold(this.data.title),
      "",
      this.data.priceHeader,
      "-".repeat(this.priceW()),
      ...this.data.priceRows,
    ];
  }

  /** Narrow terminals: the meter first (it is the primary read), a divider
   * closing it, then the full price table. */
  private stackedBody(): string[] {
    const priceW = this.priceW();
    return [
      ...this.data.meter,
      "-".repeat(priceW),
      this.theme.bold(this.data.title),
      "",
      this.data.priceHeader,
      "-".repeat(priceW),
      ...this.data.priceRows,
      "-".repeat(priceW),
    ];
  }
}
