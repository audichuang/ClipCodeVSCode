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

export function overlapsDirectory(directoryPath: string, rulePath: string): boolean {
  const directory = normalizePath(directoryPath);
  const rule = normalizePath(rulePath);
  if (!directory) return true;
  return isSameOrChild(directory, rule) || isSameOrChild(rule, directory);
}

function matchesRule(relativePath: string, rule: FilterRule, absolutePath?: string): boolean {
  if (rule.type === 'PATH') {
    return isAbsolutePath(rule.value) && absolutePath
      ? matchesPath(absolutePath, rule.value)
      : matchesPath(relativePath, rule.value);
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
    return new RegExp(`^${regexPattern}$`).test(name);
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
