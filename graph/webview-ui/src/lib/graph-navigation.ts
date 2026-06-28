export type NavDir = 'up' | 'down';

/**
 * Decide which commit hash to select next for keyboard navigation.
 *
 * `commits` is the displayed list, newest-first (index 0 = top). `jump` is true
 * when Ctrl/Cmd is held: down follows the first parent, up follows the newest child.
 * Returns the hash to select, or null when there is no valid move (caller keeps
 * the current selection).
 */
export function computeNavigationTarget(
  commits: ReadonlyArray<{ hash: string; parents: string[] }>,
  currentHash: string | null,
  dir: NavDir,
  jump: boolean,
): string | null {
  if (commits.length === 0) return null;

  const index = currentHash ? commits.findIndex((c) => c.hash === currentHash) : -1;

  // Nothing selected (or selection no longer in the list): start at the top.
  if (index < 0) return commits[0].hash;

  if (!jump) {
    const next = dir === 'down' ? commits[index + 1] : commits[index - 1];
    return next ? next.hash : null;
  }

  if (dir === 'down') {
    // Jump to the first parent, if it is loaded.
    const firstParent = commits[index].parents[0];
    if (!firstParent) return null;
    return commits.some((c) => c.hash === firstParent) ? firstParent : null;
  }

  // dir === 'up': jump to the newest child (lowest index whose parents include current).
  const cur = commits[index].hash;
  const child = commits.find((c) => c.parents.includes(cur));
  return child ? child.hash : null;
}

export type ScrollAlign = 'center' | 'edge';

/**
 * Compute the scrollTop needed to bring a row into view, or null when it is
 * already comfortably visible (caller leaves the scroll position unchanged).
 *
 * - `'edge'`: scroll the minimum amount so the row sits just inside the nearest
 *   viewport edge, keeping `marginRows` rows of breathing room beyond it. Used
 *   for arrow-key stepping so the view follows the selection one row at a time
 *   instead of jumping. The browser clamps the returned value to the scrollable
 *   range, so the margin simply collapses near the very top/bottom of the list.
 * - `'center'`: when the row is off-screen, center it in the viewport. Used for
 *   search navigation, which jumps to arbitrarily distant results. `marginRows`
 *   is ignored.
 */
export function computeScrollTop(
  rowIndex: number,
  rowHeight: number,
  scrollTop: number,
  viewportHeight: number,
  align: ScrollAlign,
  marginRows = 0,
): number | null {
  const targetY = rowIndex * rowHeight;

  if (align === 'center') {
    const above = targetY < scrollTop;
    const below = targetY + rowHeight > scrollTop + viewportHeight;
    if (!above && !below) return null;
    return targetY - viewportHeight / 2 + rowHeight / 2;
  }

  // 'edge': keep `marginRows` rows visible between the row and the edge it nears.
  const margin = marginRows * rowHeight;
  if (targetY < scrollTop + margin) return targetY - margin;
  if (targetY + rowHeight > scrollTop + viewportHeight - margin) {
    return targetY + rowHeight - viewportHeight + margin;
  }
  return null;
}

export interface JumpResult {
  /** Hash to select, or null when there is no valid move (caller keeps selection). */
  target: string | null;
  /** The updated exploration path; its last element is the new selection. */
  path: string[];
}

/**
 * Modifier-jump navigation with path memory. `path` is the trail of commits visited
 * during the current uninterrupted run of Ctrl/Cmd jumps (last element = current
 * selection). Reversing a jump retraces to where you came from instead of the
 * stateless default, so a parent's remembered child and a merge's origin parent are
 * preserved. Returns the next selection and the updated path.
 */
export function computeJumpTarget(
  commits: ReadonlyArray<{ hash: string; parents: string[] }>,
  currentHash: string | null,
  dir: NavDir,
  path: ReadonlyArray<string>,
  maxPath = 100,
): JumpResult {
  if (commits.length === 0) return { target: null, path: [] };

  const index = currentHash ? commits.findIndex((c) => c.hash === currentHash) : -1;
  if (index < 0) {
    const top = commits[0].hash;
    return { target: top, path: [top] };
  }

  const current = commits[index];

  // Anchor the working path to the current selection; a mismatch means the path is
  // stale (selection changed outside a jump), so start a fresh exploration.
  const anchored = path.length > 0 && path[path.length - 1] === currentHash;
  const working = anchored ? path.slice() : [current.hash];
  const prev = working.length >= 2 ? working[working.length - 2] : undefined;

  // Retrace: the previous path entry is a loaded neighbor in this direction.
  if (prev !== undefined && commits.some((c) => c.hash === prev)) {
    const prevIsNeighbor = dir === 'down'
      ? current.parents.includes(prev)
      : commits.some((c) => c.hash === prev && c.parents.includes(current.hash));
    if (prevIsNeighbor) {
      return { target: prev, path: working.slice(0, -1) };
    }
  }

  // Default jump target.
  let target: string | null;
  if (dir === 'down') {
    const firstParent = current.parents[0];
    target = firstParent && commits.some((c) => c.hash === firstParent) ? firstParent : null;
  } else {
    const child = commits.find((c) => c.parents.includes(current.hash));
    target = child ? child.hash : null;
  }

  if (target === null) return { target: null, path: working };

  const pushed = [...working, target];
  const trimmed = pushed.length > maxPath ? pushed.slice(pushed.length - maxPath) : pushed;
  return { target, path: trimmed };
}

/**
 * True when the row at `rowIndex` is entirely outside the visible viewport
 * (fully above the top or fully below the bottom). A row that is even partially
 * visible counts as on-screen. Uses the real viewport - not the render buffer -
 * so it reflects what the user can actually see. A negative `rowIndex` (e.g. no
 * HEAD in the list) is treated as on-screen so callers don't emphasize a no-op.
 */
export function isRowOffscreen(
  rowIndex: number,
  rowHeight: number,
  scrollTop: number,
  viewportHeight: number,
): boolean {
  if (rowIndex < 0) return false;
  const top = rowIndex * rowHeight;
  const bottom = top + rowHeight;
  return bottom <= scrollTop || top >= scrollTop + viewportHeight;
}
