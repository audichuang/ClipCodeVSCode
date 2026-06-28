export interface BranchColorRule {
  pattern: string;
  color: string;
}

export interface CompiledBranchColorRule {
  regex: RegExp;
  color: string;
}

const HEX_COLOR = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * Compile user-configured branch color rules. Entries that are not
 * `{ pattern: string, color: <hex> }` with a valid regex are skipped silently.
 * Declaration order is preserved so the first match wins at resolve time.
 */
export function compileBranchColorRules(raw: unknown): CompiledBranchColorRule[] {
  if (!Array.isArray(raw)) return [];
  const compiled: CompiledBranchColorRule[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const { pattern, color } = entry as Partial<BranchColorRule>;
    if (typeof pattern !== 'string' || typeof color !== 'string') continue;
    if (!HEX_COLOR.test(color)) continue;
    try {
      compiled.push({ regex: new RegExp(pattern), color });
    } catch {
      // Invalid regex — skip this rule.
    }
  }
  return compiled;
}

/** Build a resolver that maps a branch name to the first matching rule's color. */
export function makeBranchColorResolver(
  rules: CompiledBranchColorRule[],
): (name: string) => string | undefined {
  return (name: string) => {
    for (const rule of rules) {
      if (rule.regex.test(name)) return rule.color;
    }
    return undefined;
  };
}
