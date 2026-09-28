/**
 * Frame layout maths.
 *
 * The whole UI is one bordered frame whose height is fixed to the terminal
 * height minus one row. That last row is left alone on purpose: if a frame fills
 * the terminal exactly, writing its final newline scrolls the screen and Ink's
 * erase-and-redraw maths goes out of sync (the classic "flickering TUI" bug).
 *
 * Everything is derived from the terminal size so resizing just works.
 */

export const FRAME_HEADER_ROWS = 3; // title row, status row, divider
export const FRAME_FOOTER_ROWS = 3; // divider, input row, hint row
export const FRAME_BORDER_COLUMNS = 2; // left and right border
export const FRAME_PADDING_COLUMNS = 2; // one space of padding each side

export interface ScreenLayout {
  columns: number;
  rows: number;
  /** Width of the outer frame, including its border. */
  frameWidth: number;
  /** Height of the outer frame, including its border. */
  frameHeight: number;
  /** Usable width inside border and padding. */
  innerWidth: number;
  /** Rows available for the message/timeline area. */
  bodyRows: number;
  headerRows: number;
  footerRows: number;
  /** True when the terminal is too small to render the full frame. */
  tooSmall: boolean;
  /** Compact mode: hide secondary chrome (badges, hints) on narrow terminals. */
  compact: boolean;
}

export const MIN_COLUMNS = 34;
export const MIN_ROWS = 12;

export interface LayoutOptions {
  headerRows?: number;
  footerRows?: number;
  minBodyRows?: number;
}

export function computeLayout(
  columns: number,
  rows: number,
  options: LayoutOptions = {},
): ScreenLayout {
  // Terminals occasionally report nothing (or nonsense) for their size. Falling
  // back to a sane default keeps the frame consistent instead of producing NaN
  // dimensions, which would render garbage.
  const safeColumns = Number.isFinite(columns) && columns > 0 ? Math.floor(columns) : 80;
  const safeRows = Number.isFinite(rows) && rows > 0 ? Math.floor(rows) : 24;

  const headerRows = options.headerRows ?? FRAME_HEADER_ROWS;
  const footerRows = options.footerRows ?? FRAME_FOOTER_ROWS;
  const minBodyRows = options.minBodyRows ?? 3;

  const frameWidth = safeColumns;
  const frameHeight = Math.max(6, safeRows - 1);
  const innerWidth = Math.max(
    1,
    frameWidth - FRAME_BORDER_COLUMNS - FRAME_PADDING_COLUMNS,
  );

  const chrome = FRAME_BORDER_COLUMNS + headerRows + footerRows;
  const bodyRows = Math.max(minBodyRows, frameHeight - chrome);

  return {
    columns: safeColumns,
    rows: safeRows,
    frameWidth,
    frameHeight,
    innerWidth,
    bodyRows,
    headerRows,
    footerRows,
    tooSmall: safeColumns < MIN_COLUMNS || safeRows < MIN_ROWS,
    compact: safeColumns < 60,
  };
}
