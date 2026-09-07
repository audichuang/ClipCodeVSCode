import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/svelte';
import { tick } from 'svelte';
import RecentCommits from '../RecentCommits.svelte';

// Matches lib/types.ts Ref: `remote` is a separate optional field, so the
// fixture can carry the shape git-parser actually produces.
type TestRef = { type: string; name: string; remote?: string };

function state() {
  return {
    repoPath: '/repo', repoName: 'repo', repos: [{ path: '/repo', name: 'repo' }],
    commits: [{ hash: 'head', abbreviatedHash: 'head', subject: 'HEAD subject', refs: [{ type: 'head', name: 'HEAD' }] as TestRef[] }],
    branches: [], ahead: 0, behind: 0, tracking: false, staged: 0, unstaged: 0, conflicts: 0, locale: 'en', scope: 'HEAD',
    graph: {
      paths: [{ points: [{ x: -2, y: 0.5 }, { x: 10, y: 0.5 }], color: 0 }],
      links: [], dots: [{ center: { x: 10, y: 0.5 }, color: 0, type: 'head', isHead: true }],
    },
  };
}

describe('RecentCommits', () => {
  it('does not mistake missing upstream for a clean working tree', async () => {
    const { container } = render(RecentCommits);
    const payload = { ...state(), unstaged: 1 };
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'recentCommitsState', payload } }));
    await tick();
    expect(container.querySelector('.summary')?.textContent).toContain('Unstaged 1');
    expect(container.querySelector('.summary')?.textContent).not.toContain('No changes');
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'recentCommitsState', payload: state() } }));
    await tick();
    expect(container.querySelector('.summary')?.textContent).toContain('No changes');
  });

  // Geometry is native VS Code's Source Control Graph (row/swimlane 22, dot r5),
  // so this asserts 22-based centres — it used to pin cy=12 for the old 24px row.
  it('aligns the first dot to the 22px row and keeps it inside the rail gutter', async () => {
    const { container } = render(RecentCommits);
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'recentCommitsState', payload: state() } }));
    await Promise.resolve();

    const dot = container.querySelector<SVGCircleElement>('.dot')!;
    const svg = container.querySelector<SVGSVGElement>('svg')!;
    expect(dot.getAttribute('cy')).toBe('11');
    expect(Number(dot.getAttribute('cx'))).toBeGreaterThanOrEqual(3.5);
    expect(Number(dot.getAttribute('cx'))).toBeLessThanOrEqual(Number(svg.getAttribute('width')) - 3.5);
    expect(container.querySelector('.commit-row')?.textContent).toContain('HEAD subject');
  });

  // The row used to carry a 42px monospace hash — 16% of a 300px sidebar's
  // usable width, and the least identifying thing on the row. Native's rows
  // carry none, and the space belongs to the subject and the ref label.
  it('spends no row width on an abbreviated hash', async () => {
    const { container } = render(RecentCommits);
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'recentCommitsState', payload: state() } }));
    await Promise.resolve();

    expect(container.querySelector('.commit-hash')).toBeNull();
    expect(container.querySelector('.commit-row')?.textContent).not.toContain('head');
  });

  // Regression: refs were filtered to `remote-branch | tag`, which excluded the
  // `head` ref carrying the current LOCAL branch name — so `develop` could
  // never be labelled. One ref is named, the rest collapse to icon+count.
  it('names the local HEAD branch and collapses the remaining refs into a count', async () => {
    const { container } = render(RecentCommits);
    const payload = state();
    // Real parser shape (git-parser.ts:110-119): a remote branch keeps the
    // remote in its OWN field and `name` is the bare branch. This test used to
    // pass 'origin/develop' as `name`, a shape git-parser never produces, which
    // masked the two remotes rendering as two identical "develop" labels.
    payload.commits[0].refs = [
      { type: 'head', name: 'develop' },
      { type: 'remote-branch', name: 'develop', remote: 'origin' },
      { type: 'remote-branch', name: 'develop', remote: 'upstream' },
      { type: 'tag', name: 'v1.2.3' },
    ];
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'recentCommitsState', payload } }));
    await tick();

    const labels = [...container.querySelectorAll('.label')];
    const described = labels.map(label => label.querySelector('.description')?.textContent).filter(Boolean);
    expect(described).toEqual(['develop']);
    // At most two pills: the named one, then ONE counted pill for everything
    // else. Measured at 300px, letting the remainder split per icon left the
    // subject 70px (20px at 250px), so the strip is capped instead.
    expect(labels).toHaveLength(2);
    expect(labels[1].querySelector('.count')?.textContent).toBe('3');
    // Each remote must stay identifiable in the collapsed pill's tooltip.
    expect(labels[1].getAttribute('title')).toBe('origin/develop\nupstream/develop\nv1.2.3');
  });

});
