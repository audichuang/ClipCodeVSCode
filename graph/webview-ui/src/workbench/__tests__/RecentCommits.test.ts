import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/svelte';
import { tick } from 'svelte';
import RecentCommits from '../RecentCommits.svelte';

function state() {
  return {
    repoPath: '/repo', repoName: 'repo', repos: [{ path: '/repo', name: 'repo' }],
    commits: [{ hash: 'head', abbreviatedHash: 'head', subject: 'HEAD subject', refs: [{ type: 'head', name: 'HEAD' }] }],
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

  it('aligns the first dot to the first row and keeps its HEAD ring inside the rail', async () => {
    const { container } = render(RecentCommits);
    window.dispatchEvent(new MessageEvent('message', { data: { type: 'recentCommitsState', payload: state() } }));
    await Promise.resolve();

    const dot = container.querySelector<SVGCircleElement>('.dot-ring')!;
    const svg = container.querySelector<SVGSVGElement>('svg')!;
    expect(dot.getAttribute('cy')).toBe('12');
    expect(Number(dot.getAttribute('cx'))).toBeGreaterThanOrEqual(5);
    expect(Number(dot.getAttribute('cx'))).toBeLessThanOrEqual(Number(svg.getAttribute('width')) - 5);
    expect(container.querySelector('.commit-row')?.textContent).toContain('HEAD subject');
  });
});
