import { describe, expect, it, vi } from "vitest";
import { CalibrationView, ReportView, type ViewTheme } from "../src/views.js";
import type { CalRow, CalProgress } from "../src/calibrate.js";
import type { CapReportData } from "../src/usage.js";
import { MODELS } from "../src/catalog.js";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";

/** No-op theme: render output stays plain text, easy to assert on. */
const theme: ViewTheme = { fg: (_color, text) => text, bold: (text) => text };

const makeTui = (rows: number): TUI =>
  ({ requestRender: vi.fn(), terminal: { rows } }) as unknown as TUI;

const paid = MODELS.filter((m) => m.cost.input > 0);

/** 14 rows in catalog order: 4 done, 3 running, the rest queued. */
const progressFixture = (): CalProgress => ({
  done: 4,
  total: paid.length,
  spentUsd: 0.0312,
  rows: paid.map<CalRow>((m, i) => ({
    id: m.id,
    name: m.name,
    state: i < 4 ? "done" : i < 7 ? "running" : "queued",
    detail: i < 4 ? "unchanged" : i < 7 ? `T${i - 3}` : undefined,
  })),
});

const calView = (rows: number): CalibrationView =>
  new CalibrationView(makeTui(rows), theme, {
    onCancel: vi.fn(),
    onClose: vi.fn(),
  });

/** Body rows of the calibration modal: icon + space + a model name. */
const calBody = (lines: string[]): string[] =>
  lines.filter((l) => /^│ *[·…✓✗] [A-Z]/.test(l));

/** The model names the modal shows, left column first then right. */
const rowNames = (lines: string[]): string[] => {
  const cols = calBody(lines).map((l) => l.slice(2, -2).split(" │ "));
  const strip = (cell: string): string =>
    cell.trim().replace(/^[·…✓✗] /, "").split(/\s{2,}/)[0]!.trimEnd();
  return [...cols.map((c) => strip(c[0]!)), ...cols.map((c) => strip(c[1]!))];
};

describe("CalibrationView layout", () => {
  it("fills column-major: models 1-7 down the left, 8-14 down the right", () => {
    const view = calView(40);
    view.update(progressFixture());
    const lines = view.render(view.width);

    expect(calBody(lines)).toHaveLength(7);
    expect(rowNames(lines)).toEqual(paid.map((m) => m.name));
  });

  it("splits into two equal columns with one separator column", () => {
    const view = calView(40);
    view.update(progressFixture());
    const lines = view.render(view.width);

    const cells = calBody(lines).map((l) => l.slice(2, -2));
    // Same separator in every row → the split is symmetric, never drifting
    // with per-column content widths.
    expect(new Set(cells.map((c) => c.indexOf(" │ "))).size).toBe(1);
    // Rows fill the inner box width exactly — nothing runs past the border.
    expect(cells.every((c) => c.length === view.width - 4)).toBe(true);
  });

  it("lays the columns out like a document: balanced spacing, left-aligned text", () => {
    const view = calView(40);
    view.update(progressFixture());
    const lines = view.render(view.width);

    for (const cell of calBody(lines).map((l) => l.slice(2, -2))) {
      // The outer margins are symmetric — text never touches the border.
      expect(cell.startsWith("   ")).toBe(true);
      expect(cell.endsWith("   ")).toBe(true);
      // The separator breathes the SAME width as the margins; only the
      // name→detail gap inside a row breathes wider.
      const idx = cell.indexOf(" │ ");
      expect(cell.slice(idx - 3, idx)).toBe("   ");
      expect(cell.slice(idx + 3, idx + 6)).toBe("   ");
      // Both columns are identical 50-wide cells at the same inset.
      const [left, right] = [cell.slice(3, 3 + 50), cell.slice(idx + 6, idx + 6 + 50)];
      expect(left.length).toBe(50);
      expect(right.length).toBe(50);
    }
  });

  it("falls back to a single frontier window on narrow terminals", () => {
    // 16-row terminal: the window is small, the frontier is in view.
    const view = calView(16);
    view.update(progressFixture());
    const lines = view.render(60);
    const body = calBody(lines);

    expect(lines.some((l) => l.includes("done above"))).toBe(true);
    expect(body[0]).toContain("Kimi K2.6"); // rows[4] — first non-done
    expect(body).toHaveLength(6); // the row budget at 16 terminal rows
  });

  it("confirms cancel on double-escape within the arm window", () => {
    const onCancel = vi.fn();
    const view = new CalibrationView(makeTui(40), theme, { onCancel, onClose: vi.fn() });
    view.update(progressFixture());
    view.render(view.width);

    view.handleInput("\x1b"); // arm
    expect(onCancel).not.toHaveBeenCalled();
    view.handleInput("\x1b"); // confirm
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("closes on any key once finished", () => {
    const onClose = vi.fn();
    const view = new CalibrationView(makeTui(40), theme, { onCancel: vi.fn(), onClose });
    view.update(progressFixture());
    view.render(view.width);
    view.handleInput("x"); // ignored while running
    expect(onClose).not.toHaveBeenCalled();
    view.finish("cancelled — 4 repriced");
    view.handleInput("x");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("hugs its content: the modal width is the columns plus document margins", () => {
    const view = calView(40);
    // Row: 2×margin(3) + two 50-wide columns + 2×gap(3) + separator(3).
    const rowWidth = 2 * 3 + 2 * 50 + 2 * 3 + 3;
    // Box width adds the border padding (4).
    expect(view.width).toBe(rowWidth + 4);
  });
});

const priceNameW = 24;
const priceTableW = priceNameW + 27;
const priceRow = (name: string): string =>
  `${name.padEnd(priceNameW)}${"1.00".padStart(9)}${"2.00".padStart(9)}${"3.00".padStart(9)}`;

const reportData = (): CapReportData => ({
  title: "ClinePass Model Rates ($ / 1M tokens)",
  priceHeader: "MODEL".padEnd(priceNameW) + "INPUT".padStart(9) + "OUTPUT".padStart(9) + "CACHE-R".padStart(9),
  priceRows: [
    priceRow("LongCat 2.0 (free)"),
    "-".repeat(priceTableW),
    ...Array.from({ length: 14 }, (_, i) => priceRow(`p${i}`)),
  ],
  planRows: ["Cline Pass (Monthly) • Active until …", "-".repeat(71), "5-Hour Limit …", "Weekly Limit …", "Monthly Limit …"],
  meter: [
    "Cline Pass (Monthly) (2h remaining) - ⚠︎ Expiring soon!",
    "• Active until Aug 30, 2026 02:14 PM",
    "",
    "5-Hour   ($n/a) : [██░░░░░░░░]  42% (resets 1h)",
    "",
    "Weekly   ($n/a) : [███░░░░░░░]  24% (resets Sep 2, 04:00)",
    "",
    "Monthly  ($n/a) : [██████░░░░]  75% (resets Sep 8, 18:18)",
  ],
  priceTableW,
});

describe("ReportView layout", () => {
  it("places the meter left and the price column (with its own title) right", () => {
    const view = new ReportView(makeTui(40), theme, reportData(), vi.fn());
    const lines = view.render(view.width);

    // The price title heads the right column at the top; the meter's plan
    // line is the sidebar on the left (lower than the title — centered).
    const titleRow = lines.findIndex((l) => l.includes("ClinePass Model Rates"));
    const planRow = lines.findIndex((l) => l.includes("Cline Pass (Monthly)"));
    expect(titleRow).toBeGreaterThan(0);
    expect(planRow).toBeGreaterThan(titleRow);
    // Meter block, original formats — no "Limit" word, spaced rows.
    expect(lines.some((l) => l.includes("• Active until Aug 30, 2026 02:14 PM"))).toBe(true);
    expect(lines.some((l) => l.includes("5-Hour   ($n/a) : [██░░░░░░░░]  42% (resets 1h)"))).toBe(true);
    expect(lines.some((l) => l.includes("Weekly   ($n/a)"))).toBe(true);
    expect(lines.some((l) => l.includes("Monthly  ($n/a)"))).toBe(true);
    const footer = lines.find((l) => l.includes("[esc] close"))!;
    expect(footer).toContain("[esc] close");
  });

  it("stacks the meter first, closes it with a divider, then the price table", () => {
    const view = new ReportView(makeTui(40), theme, reportData(), vi.fn());
    const lines = view.render(60);

    const meterIdx = lines.findIndex((l) => l.includes("Cline Pass (Monthly)"));
    const titleIdx = lines.findIndex((l) => l.includes("ClinePass Model Rates"));
    const headerIdx = lines.findIndex((l) => l.includes("MODEL"));
    expect(meterIdx).toBeGreaterThan(0);
    expect(meterIdx).toBeLessThan(titleIdx);
    expect(titleIdx).toBeLessThan(headerIdx);
    // A full-width dash row closes the meter block.
    const dashRow = lines.slice(meterIdx, titleIdx).find((l) => /^│ -+│/.test(l.replace(/│ | │/g, "│")) || /^│ -/.test(l));
    expect(dashRow).toBeDefined();
  });

  it("centers the meter block vertically beside the taller price column", () => {
    const view = new ReportView(makeTui(40), theme, reportData(), vi.fn());
    const lines = view.render(view.width);

    const first = lines.findIndex((l) => l.includes("Cline Pass (Monthly)"));
    const last = lines.findIndex((l) => l.includes("Monthly  ($n/a)"));
    const boxTop = lines.findIndex((l) => l.startsWith("┌"));
    const boxBottom = lines.findIndex((l) => l.startsWith("└"));
    // Rows above the block vs rows between the block and the blank+footer
    // rows (the two chrome rows after the content).
    const top = first - boxTop - 1;
    const bottom = boxBottom - last - 3;
    // The meter block sits mid-height, not wedged to the top corner.
    expect(top).toBeGreaterThan(1);
    expect(Math.abs(top - bottom)).toBeLessThanOrEqual(1);
  });

  it("splits balanced: the meter/price separator sits at the same visual column in every row", () => {
    const view = new ReportView(makeTui(40), theme, reportData(), vi.fn());
    const lines = view.render(view.width);

    const seps = new Set<number>();
    for (const l of lines) {
      const inner = l.slice(2, -2);
      const idx = inner.indexOf(" │ ");
      // Visible column, not string index: the ⚠︎ meter glyph is 1 cell wide
      // but 2 code units, so raw indices shift by a cell on that row.
      if (idx > 0) seps.add(visibleWidth(inner.slice(0, idx + 1)));
    }
    expect(seps.size).toBe(1);

    // Document layout: uniform margin — the table starts after the
    // separator's breathing room, and the row carries the same margin at
    // both outer edges.
    const headerRow = lines.find((l) => l.includes("MODEL") && l.includes("CACHE-R"))!;
    expect(headerRow.startsWith("│   ")).toBe(true);
    expect(headerRow.endsWith("   │")).toBe(true);
    const inner = headerRow.slice(2, -2);
    const idx = inner.indexOf(" │ ");
    expect(inner.slice(idx - 3, idx)).toBe("   ");
    expect(inner.slice(idx + 3, idx + 6)).toBe("   ");
  });

  it("keeps the footer off the content with a blank row", () => {
    const view = new ReportView(makeTui(40), theme, reportData(), vi.fn());
    const lines = view.render(view.width);
    const footerIdx = lines.findIndex((l) => l.includes("[esc] close"));
    expect(footerIdx).toBeGreaterThan(0);
    expect(lines[footerIdx - 1]).toMatch(/^│ +│$/);
  });

  it("never draws past the border: widths that cannot hold the split stack instead", () => {
    const view = new ReportView(makeTui(40), theme, reportData(), vi.fn());
    // Narrower than the natural box: the overlay would clamp to this.
    const lines = view.render(113);

    // Stacked: the meter and the price block are separate box rows.
    expect(lines.some((l) => l.includes("Cline Pass (Monthly)"))).toBe(true);
    expect(lines.some((l) => l.includes("ClinePass Model Rates"))).toBe(true);
    // Every rendered line fits the box width exactly — no border overflow.
    expect(lines.every((l) => visibleWidth(l) === 113)).toBe(true);
  });

  it("scrolls the price window only — the meter stays pinned", () => {
    const tui = makeTui(24); // short terminal → the price window is scrollable
    const view = new ReportView(tui, theme, reportData(), vi.fn());
    const before = view.render(view.width);
    expect(before.some((l) => l.includes("MODEL"))).toBe(true);

    view.handleInput("\x1b[B"); // down arrow — the price title scrolls out
    const after = view.render(view.width);
    expect(after.some((l) => l.includes("ClinePass Model Rates"))).toBe(false);

    // Pinned: the meter rows stay at the same box rows.
    const idxOf = (lines: string[], s: string): number => lines.findIndex((l) => l.includes(s));
    expect(idxOf(after, "5-Hour   ($n/a)")).toBe(idxOf(before, "5-Hour   ($n/a)"));
    expect(idxOf(after, "Cline Pass (Monthly)")).toBe(idxOf(before, "Cline Pass (Monthly)"));
  });

  it("closes on escape", () => {
    const onClose = vi.fn();
    const view = new ReportView(makeTui(40), theme, reportData(), onClose);
    view.render(view.width);
    view.handleInput("\x1b");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("hugs its content: width is the columns plus document margins", () => {
    const view = new ReportView(makeTui(40), theme, reportData(), vi.fn());
    const meterW = Math.max(40, ...reportData().meter.map((l) => visibleWidth(l)));
    // Row: 2×margin(3) + meter column + 2×gap(3) + separator(3) + price table.
    const rowWidth = 2 * 3 + meterW + 2 * 3 + 3 + priceTableW;
    // Box width adds the border padding (4).
    expect(view.width).toBe(rowWidth + 4);
  });
});
