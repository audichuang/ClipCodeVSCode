const HEX_COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * Built-in graph rail palette. Kept in sync with the `gitGraphPlus.graphColors`
 * default in package.json and the webview's DEFAULT_GRAPH_COLORS.
 */
export const DEFAULT_GRAPH_COLORS: string[] = [
  '#63b0f4', '#73d13d', '#ff7a45', '#b37feb',
  '#f759ab', '#36cfc9', '#ffc53d', '#ff4d4f',
  '#597ef7', '#9254de', '#43e8d8', '#faad14',
];

/**
 * Validate a user-configured graph color palette. Keeps only valid `#rgb` /
 * `#rrggbb` strings (invalid entries are skipped silently, mirroring
 * compileBranchColorRules). Falls back to DEFAULT_GRAPH_COLORS when the result
 * would be empty (empty config, all-invalid entries, or non-array input).
 */
export function resolveGraphColors(raw: unknown): string[] {
  if (!Array.isArray(raw)) return DEFAULT_GRAPH_COLORS;
  const colors = raw.filter(
    (c): c is string => typeof c === 'string' && HEX_COLOR.test(c),
  );
  return colors.length > 0 ? colors : DEFAULT_GRAPH_COLORS;
}
