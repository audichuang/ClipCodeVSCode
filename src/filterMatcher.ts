import path from 'node:path';
import type { FilterRule } from './settings.js';

export function fileMatchesFilters(
  relativePath: string,
  rules: FilterRule[],
  useIncludeFilters: boolean,
  useExcludeFilters: boolean,
  absolutePath?: string
): boolean {
  const enabled = rules.filter(rule => rule.enabled);
  const excludeRules = enabled.filter(rule => rule.action === 'EXCLUDE');
  const includeRules = enabled.filter(rule => rule.action === 'INCLUDE');

  if (useExcludeFilters && excludeRules.some(rule => matchesRule(relativePath, rule, absolutePath))) {
    return false;
  }

  if (useIncludeFilters && includeRules.length > 0) {
    return includeRules.some(rule => matchesRule(relativePath, rule, absolutePath));
  }

  return true;
}

export function matchesPath(candidatePath: string, rulePath: string): boolean {
  return isSameOrChild(normalizePath(candidatePath), normalizePath(rulePath));
}

// 目錄被啟用的 PATH exclude 規則命中時可整棵剪枝：matchesPath 是 same-or-child，
// 該目錄下每個檔案也必然被同一規則排除，跳過子樹是純優化、不改行為。
// PATTERN 規則比對的是檔名，不能用來剪目錄。
export function directoryExcluded(
  relativePath: string,
  rules: FilterRule[],
  absolutePath?: string
): boolean {
  return rules.some(rule =>
    rule.enabled &&
    rule.action === 'EXCLUDE' &&
    rule.type === 'PATH' &&
    matchesRule(relativePath, rule, absolutePath)
  );
}

export function overlapsDirectory(directoryPath: string, rulePath: string): boolean {
  const directory = normalizePath(directoryPath);
  const rule = normalizePath(rulePath);
  if (!directory) return true;
  return isSameOrChild(directory, rule) || isSameOrChild(rule, directory);
}

function matchesRule(relativePath: string, rule: FilterRule, absolutePath?: string): boolean {
  if (rule.type === 'PATH') {
    if (isAbsolutePath(rule.value) && absolutePath) return matchesPath(absolutePath, rule.value);
    // A file that lands outside every workspace root has NO relative identity — the callers
    // pass its absolute path through as `relativePath` because that is what
    // toClipboardPathFromRoots returns for it. normalizePath strips the leading `/`, so
    // `/repo/secret.txt` used to satisfy a relative rule `repo/secret.txt` by coincidence.
    // IntelliJ never could: CopyPathFormatter.relativeFilterPath returns null for an
    // absolute path and the rule is skipped. Mirror that, in the one place all three copy
    // surfaces (SCM, History, Graph) route through.
    if (isAbsolutePath(relativePath)) return false;
    return matchesPath(relativePath, rule.value);
  }
  return matchesPattern(fileName(relativePath), rule.value);
}

function fileName(relativePath: string): string {
  return normalizePath(relativePath).split('/').pop() ?? path.basename(relativePath);
}

function matchesPattern(name: string, pattern: string): boolean {
  try {
    const regexPattern = pattern.includes('*') || pattern.includes('?')
      ? pattern.replaceAll('.', '\\.').replaceAll('*', '.*').replaceAll('?', '.')
      : pattern;
    return new RegExp(`^(?:${regexPattern})$`).test(name);
  } catch {
    return name.includes(pattern);
  }
}

function isSameOrChild(candidatePath: string, parentPath: string): boolean {
  if (!parentPath) return true;
  if (!candidatePath) return false;
  return candidatePath === parentPath || candidatePath.startsWith(`${parentPath}/`);
}

function normalizePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/\/+/g, '/').trim().replace(/^\/+|\/+$/g, '');
}

function isAbsolutePath(value: string): boolean {
  const normalized = value.replaceAll('\\', '/');
  return normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized);
}
