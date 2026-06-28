import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/svelte';
import ActivityLog from '../ActivityLog.svelte';
import { i18n } from '../../../lib/i18n/index.svelte';

interface LogEntry {
  command: string;
  timestamp: string;
  success: boolean;
  duration: number;
}

function entry(over: Partial<LogEntry> = {}): LogEntry {
  return {
    command: 'git status',
    timestamp: new Date().toISOString(),
    success: true,
    duration: 50,
    ...over,
  };
}

function deliverLog(entries: LogEntry[]) {
  window.dispatchEvent(new MessageEvent('message', {
    data: { type: 'activityLogData', payload: entries },
  }));
}

beforeEach(() => {
  i18n.setLocale('en');
  globalThis.__postedMessages = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ActivityLog', () => {
  it('requests activity log on mount', () => {
    render(ActivityLog);
    expect(globalThis.__postedMessages.some(
      (m) => (m.data as { type?: string }).type === 'getActivityLog'
    )).toBe(true);
  });

  it('filters out non-user-action commands by default', async () => {
    const { container } = render(ActivityLog);
    deliverLog([
      entry({ command: 'git status' }), // hidden
      entry({ command: 'git commit -m fix' }), // shown
      entry({ command: 'git log --format=...' }), // hidden
    ]);
    await waitFor(() => {
      expect(container.querySelectorAll('.log-entry').length).toBe(1);
    });
  });

  it('"show all" toggles visibility of internal commands', async () => {
    const { container } = render(ActivityLog);
    deliverLog([
      entry({ command: 'git status' }),
      entry({ command: 'git commit -m fix' }),
    ]);
    await waitFor(() => container.querySelector('.log-entry'));
    const showAll = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await fireEvent.click(showAll);
    await waitFor(() => {
      expect(container.querySelectorAll('.log-entry').length).toBe(2);
    });
  });

  it('failed entries get the failed class', async () => {
    const { container } = render(ActivityLog);
    deliverLog([entry({ command: 'git push', success: false })]);
    await waitFor(() => container.querySelector('.log-entry'));
    expect(container.querySelector('.log-entry')?.classList.contains('failed')).toBe(true);
  });

  it('refresh button posts another getActivityLog', async () => {
    const { container } = render(ActivityLog);
    globalThis.__postedMessages = [];
    await fireEvent.click(container.querySelector<HTMLButtonElement>('.log-refresh')!);
    expect(globalThis.__postedMessages.some(
      (m) => (m.data as { type?: string }).type === 'getActivityLog'
    )).toBe(true);
  });

  it('shows empty state when there are no entries', async () => {
    const { container } = render(ActivityLog);
    deliverLog([]);
    await waitFor(() => {
      expect(container.querySelector('.log-empty')).not.toBeNull();
    });
  });

  it('auto-refresh interval fires another request after 2s', () => {
    render(ActivityLog);
    globalThis.__postedMessages = [];
    vi.advanceTimersByTime(2000);
    expect(globalThis.__postedMessages.some(
      (m) => (m.data as { type?: string }).type === 'getActivityLog'
    )).toBe(true);
  });

  it('formats duration in ms for sub-second commands', async () => {
    const { container } = render(ActivityLog);
    deliverLog([entry({ command: 'git commit fast', duration: 50 })]);
    await waitFor(() => container.querySelector('.log-duration'));
    expect(container.querySelector('.log-duration')?.textContent?.trim()).toBe('50ms');
  });

  it('formats duration in seconds for commands taking >= 1s', async () => {
    const { container } = render(ActivityLog);
    deliverLog([entry({ command: 'git rebase slow', duration: 2500 })]);
    await waitFor(() => container.querySelector('.log-duration'));
    expect(container.querySelector('.log-duration')?.textContent?.trim()).toBe('2.5s');
  });

  it('truncates --format=... values in the displayed command', async () => {
    const { container } = render(ActivityLog);
    deliverLog([entry({ command: 'git commit --format=%H' })]);
    await waitFor(() => container.querySelector('.log-command'));
    expect(container.querySelector('.log-command')?.textContent).toContain('--format=…');
  });
});
