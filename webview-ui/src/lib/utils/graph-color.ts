/**
 * Built-in graph rail palette. Kept in sync with the `gitGraphPlus.graphColors`
 * default in package.json and the extension's DEFAULT_GRAPH_COLORS. Used as the
 * palette store's initial value and as the fallback for an empty palette.
 */
export const DEFAULT_GRAPH_COLORS: string[] = [
  '#63b0f4', '#73d13d', '#ff7a45', '#b37feb',
  '#f759ab', '#36cfc9', '#ffc53d', '#ff4d4f',
  '#597ef7', '#9254de', '#43e8d8', '#faad14',
];

/**
 * Resolve a graph element's display color: a pattern-matched override wins,
 * otherwise fall back to the auto-assigned palette color (index wraps).
 */
export function resolveGraphColor(palette: string[], index: number, override?: string): string {
  if (override) return override;
  return palette[index % palette.length];
}
