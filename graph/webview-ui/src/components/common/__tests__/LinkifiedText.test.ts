import { describe, it, expect, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import LinkifiedText from '../LinkifiedText.svelte';
import { commitLinkRulesStore } from '../../../lib/stores/commit-link-rules.svelte';
import { i18n } from '../../../lib/i18n/index.svelte';

beforeEach(() => {
  i18n.setLocale('en');
  commitLinkRulesStore.set([]);
  globalThis.__postedMessages = [];
});

describe('LinkifiedText', () => {
  it('renders plain text when no rules match', () => {
    const { container } = render(LinkifiedText, { props: { text: 'plain message' } });
    expect(container.textContent).toBe('plain message');
    expect(container.querySelector('a.commit-link')).toBeNull();
  });

  it('renders a link for a matching reference', () => {
    commitLinkRulesStore.set([{ pattern: '#(\\d+)', url: 'https://gh/issues/$1' }]);
    const { container } = render(LinkifiedText, { props: { text: 'fix #12' } });
    const link = container.querySelector('a.commit-link') as HTMLAnchorElement;
    expect(link).not.toBeNull();
    expect(link.textContent).toBe('#12');
    expect(link.getAttribute('href')).toBe('https://gh/issues/12');
  });

  it('posts openExternalUrl on click and prevents default', async () => {
    commitLinkRulesStore.set([{ pattern: '#(\\d+)', url: 'https://gh/issues/$1' }]);
    const { container } = render(LinkifiedText, { props: { text: 'fix #12' } });
    const link = container.querySelector('a.commit-link') as HTMLAnchorElement;
    const evt = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(evt);
    expect(evt.defaultPrevented).toBe(true);
    expect(globalThis.__postedMessages).toContainEqual({
      data: { type: 'openExternalUrl', payload: { url: 'https://gh/issues/12' } },
    });
  });
});
