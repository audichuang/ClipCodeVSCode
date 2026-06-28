export type FilterType = 'PATH' | 'PATTERN';
export type FilterAction = 'INCLUDE' | 'EXCLUDE';

export interface FilterRule {
  type: FilterType;
  action: FilterAction;
  value: string;
  enabled: boolean;
}

export interface ClipCodeSettings {
  headerFormat: string;
  preText: string;
  postText: string;
  addExtraLineBetweenFiles: boolean;
  setMaxFileCount: boolean;
  fileCountLimit: number;
  maxFileSizeKB: number;
  showCopyNotification: boolean;
  useFilters: boolean;
  useIncludeFilters: boolean;
  useExcludeFilters: boolean;
  filterRules: FilterRule[];
}

export const defaultSettings: ClipCodeSettings = {
  headerFormat: '// file: $FILE_PATH',
  preText: '',
  postText: '',
  addExtraLineBetweenFiles: true,
  setMaxFileCount: true,
  fileCountLimit: 30,
  maxFileSizeKB: 500,
  showCopyNotification: true,
  useFilters: false,
  useIncludeFilters: true,
  useExcludeFilters: true,
  filterRules: []
};

export function normalizeSettings(input: Partial<ClipCodeSettings> = {}): ClipCodeSettings {
  return {
    ...defaultSettings,
    ...input,
    fileCountLimit: positiveNumber(input.fileCountLimit, defaultSettings.fileCountLimit),
    maxFileSizeKB: positiveNumber(input.maxFileSizeKB, defaultSettings.maxFileSizeKB),
    filterRules: (input.filterRules ?? []).filter(isFilterRule)
  };
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function isFilterRule(value: unknown): value is FilterRule {
  if (!value || typeof value !== 'object') return false;
  const rule = value as Record<string, unknown>;
  return (rule.type === 'PATH' || rule.type === 'PATTERN') &&
    (rule.action === 'INCLUDE' || rule.action === 'EXCLUDE') &&
    typeof rule.value === 'string' &&
    typeof rule.enabled === 'boolean';
}
