import { DEFAULT_GRAPH_COLORS } from '../utils/graph-color';

/**
 * Holds the graph rail palette pushed from the extension
 * (`gitGraphPlus.graphColors`). The extension already validates and falls back
 * to the default, so this store only guards against an empty array.
 */
class GraphColorsStore {
  palette = $state<string[]>([...DEFAULT_GRAPH_COLORS]);

  set(colors: string[]) {
    this.palette = colors.length > 0 ? colors : [...DEFAULT_GRAPH_COLORS];
  }
}

export const graphColorsStore = new GraphColorsStore();
