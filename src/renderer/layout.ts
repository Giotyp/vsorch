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
