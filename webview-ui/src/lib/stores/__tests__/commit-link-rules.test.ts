import { describe, it, expect, beforeEach } from 'vitest';
import { commitLinkRulesStore } from '../commit-link-rules.svelte';

describe('commitLinkRulesStore', () => {
  beforeEach(() => commitLinkRulesStore.set([]));

  it('defaults to an empty list', () => {
    expect(commitLinkRulesStore.rules).toEqual([]);
  });

  it('stores rules pushed from the extension', () => {
    const rules = [{ pattern: '#(\\d+)', url: 'https://x/$1' }];
    commitLinkRulesStore.set(rules);
    expect(commitLinkRulesStore.rules).toEqual(rules);
  });
});
