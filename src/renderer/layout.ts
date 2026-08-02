/** Pane layout math — pure functions, no DOM. */

export type LayoutKind = 'row' | 'column' | 'grid';

/**
 * How many panes go in each row for `count` panes under a layout.
 *  - row:    [count]              (everything side by side)
 *  - column: [1, 1, ...]          (everything stacked)
 *  - grid:   near-square, filled row by row — 3 → [2, 1], 5 → [3, 2]
 */
export function rowsFor(kind: LayoutKind, count: number): number[] {
  if (count <= 0) return [];
  switch (kind) {
    case 'row':
      return [count];
    case 'column':
      return new Array<number>(count).fill(1);
    case 'grid': {
      const cols = Math.ceil(Math.sqrt(count));
      const rows: number[] = [];
      for (let left = count; left > 0; left -= cols) {
        rows.push(Math.min(cols, left));
      }
      return rows;
    }
  }
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

function lcm(a: number, b: number): number {
  return (a / gcd(a, b)) * b;
}

export interface PanePlacement {
  /** 1-based grid row. */
  row: number;
  /** 1-based grid column start. */
  columnStart: number;
  /** Number of grid columns to span. */
  columnSpan: number;
}

export interface GridPlan {
  /** Total number of template columns (LCM of the row sizes). */
  columns: number;
  /** Total number of template rows. */
  rows: number;
  /** One placement per pane, in pane order. */
  placements: PanePlacement[];
}

/**
 * Compute a CSS-grid plan for the given layout. Rows of different sizes are
 * reconciled by using LCM(row sizes) template columns and letting each pane
 * span columns/rowSize of them — e.g. rows [2, 1] → 2 columns, the lone
 * second-row pane spans both.
 */
export function planLayout(kind: LayoutKind, count: number): GridPlan {
  const rows = rowsFor(kind, count);
  const columns = rows.reduce((acc, size) => lcm(acc, size), 1);
  const placements: PanePlacement[] = [];
  rows.forEach((size, rowIndex) => {
    const span = columns / size;
    for (let i = 0; i < size; i++) {
      placements.push({
        row: rowIndex + 1,
        columnStart: i * span + 1,
        columnSpan: span,
      });
    }
  });
  return { columns, rows: rows.length, placements };
}
