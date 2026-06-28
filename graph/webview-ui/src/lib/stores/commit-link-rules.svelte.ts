import type { LinkRule } from '../linkify';

/**
 * Holds the commit-message link rules pushed from the extension
 * (`gitGraphPlus.commitMessageLinks` + built-in auto-detection). The extension
 * has already validated them, so this store just stores and exposes the list.
 */
class CommitLinkRulesStore {
  rules = $state<LinkRule[]>([]);

  set(rules: LinkRule[]) {
    this.rules = rules;
  }
}

export const commitLinkRulesStore = new CommitLinkRulesStore();
