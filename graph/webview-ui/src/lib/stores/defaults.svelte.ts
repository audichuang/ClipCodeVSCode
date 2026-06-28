import { DEFAULT_MODAL_DEFAULTS, type ModalDefaults } from '../defaults-shape';

// enum whitelists per field; any value not present falls back.
const ENUMS: Record<string, readonly string[]> = {
  'push.force': ['none', 'with-lease', 'force'],
  'merge.mode': ['default', 'no-ff', 'squash'],
  'checkout.dirty': ['keep', 'stash', 'discard'],
  'checkoutRemote.dirty': ['keep', 'stash', 'discard'],
  'reset.mode': ['soft', 'mixed', 'hard'],
};

/**
 * Normalizes a raw (possibly partial / malformed) defaults object from VS Code
 * settings into a fully-populated ModalDefaults, filling every missing or
 * invalid field from DEFAULT_MODAL_DEFAULTS. Enum fields are whitelist-checked;
 * boolean fields fall back unless the raw value is a real boolean.
 */
export function resolveDefaults(raw: unknown): ModalDefaults {
  const result = structuredClone(DEFAULT_MODAL_DEFAULTS);
  if (!raw || typeof raw !== 'object') { return result; }
  for (const modal of Object.keys(result) as (keyof ModalDefaults)[]) {
    const rawModal = (raw as Record<string, unknown>)[modal];
    if (!rawModal || typeof rawModal !== 'object') { continue; }
    const target = result[modal] as Record<string, unknown>;
    for (const field of Object.keys(target)) {
      const value = (rawModal as Record<string, unknown>)[field];
      const enumKey = `${modal}.${field}`;
      if (enumKey in ENUMS) {
        if (typeof value === 'string' && ENUMS[enumKey].includes(value)) { target[field] = value; }
      } else if (typeof value === 'boolean') {
        target[field] = value;
      }
      // otherwise keep the fallback already in `result`
    }
  }
  return result;
}

class DefaultsStore {
  current = $state<ModalDefaults>(structuredClone(DEFAULT_MODAL_DEFAULTS));

  set(raw: unknown) {
    this.current = resolveDefaults(raw);
  }
}

export const defaultsStore = new DefaultsStore();
