import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import ColorSelect from '../ColorSelect.svelte';
import { tooltip } from '../../../lib/actions/tooltip';

const options = [
  { value: 'main', label: 'main', color: '#4caf50' },
  { value: 'feature/x', label: 'feature/x', color: '#2196f3' },
  { value: 'develop', label: 'develop', color: '#9c27b0' },
];

// A standalone node carrying a real tooltip, used to probe whether the global
// tooltip suppression is active while the dropdown is open.
function makeTooltipProbe(): HTMLButtonElement {
  const probe = document.createElement('button');
  document.body.appendChild(probe);
  tooltip(probe, 'probe tip');
  return probe;
}

function hoverProbe(probe: HTMLElement) {
  probe.dispatchEvent(new MouseEvent('mouseenter', { clientX: 10, clientY: 10, bubbles: true }));
}

describe('ColorSelect', () => {
  it('shows the option matching `value` as the current selection', () => {
    const { container } = render(ColorSelect, {
      options, value: 'develop', onChange: vi.fn(),
    });
    const label = container.querySelector('.color-select-btn .label');
    expect(label?.textContent).toBe('develop');
  });

  it('falls back to the first option when value matches nothing', () => {
    const { container } = render(ColorSelect, {
      options, value: 'unknown', onChange: vi.fn(),
    });
    const label = container.querySelector('.color-select-btn .label');
    expect(label?.textContent).toBe('main');
  });

  it('does not render the dropdown until the button is clicked', () => {
    const { container } = render(ColorSelect, {
      options, value: 'main', onChange: vi.fn(),
    });
    expect(container.querySelector('.color-select-dropdown')).toBeNull();
  });

  it('clicking the button opens the dropdown with one row per option', async () => {
    const { container } = render(ColorSelect, {
      options, value: 'main', onChange: vi.fn(),
    });
    await fireEvent.click(container.querySelector<HTMLButtonElement>('.color-select-btn')!);
    const dropdown = container.querySelector('.color-select-dropdown');
    expect(dropdown).not.toBeNull();
    expect(dropdown!.querySelectorAll('.color-select-option').length).toBe(3);
  });

  it('selecting an option calls onChange and closes the dropdown', async () => {
    const onChange = vi.fn();
    const { container } = render(ColorSelect, {
      options, value: 'main', onChange,
    });
    await fireEvent.click(container.querySelector<HTMLButtonElement>('.color-select-btn')!);
    const opts = container.querySelectorAll<HTMLButtonElement>('.color-select-dropdown .color-select-option');
    await fireEvent.click(opts[1]); // feature/x
    expect(onChange).toHaveBeenCalledWith('feature/x');
    expect(container.querySelector('.color-select-dropdown')).toBeNull();
  });

  it('marks the currently-selected option with .selected inside the open dropdown', async () => {
    const { container } = render(ColorSelect, {
      options, value: 'feature/x', onChange: vi.fn(),
    });
    await fireEvent.click(container.querySelector<HTMLButtonElement>('.color-select-btn')!);
    const selected = container.querySelector('.color-select-dropdown .color-select-option.selected');
    expect(selected?.textContent).toContain('feature/x');
  });

  it('clicking outside the component closes the open dropdown', async () => {
    const { container } = render(ColorSelect, {
      options, value: 'main', onChange: vi.fn(),
    });
    await fireEvent.click(container.querySelector<HTMLButtonElement>('.color-select-btn')!);
    expect(container.querySelector('.color-select-dropdown')).not.toBeNull();
    // capture-phase outside click handler.
    await fireEvent.click(document.body);
    expect(container.querySelector('.color-select-dropdown')).toBeNull();
  });

  it('suppresses hover tooltips while the dropdown is open', async () => {
    vi.useFakeTimers();
    const { container, unmount } = render(ColorSelect, { options, value: 'main', onChange: vi.fn() });
    try {
      const probe = makeTooltipProbe();
      await fireEvent.click(container.querySelector<HTMLButtonElement>('.color-select-btn')!);
      hoverProbe(probe);
      vi.advanceTimersByTime(500);
      expect(document.body.querySelector('.vsg-tooltip')).toBeNull();
    } finally {
      unmount(); // releases the suppression held by the open dropdown
      vi.useRealTimers();
      document.body.innerHTML = '';
    }
  });

  it('re-enables hover tooltips after the dropdown closes', async () => {
    vi.useFakeTimers();
    const { container, unmount } = render(ColorSelect, { options, value: 'main', onChange: vi.fn() });
    try {
      const probe = makeTooltipProbe();
      const btn = container.querySelector<HTMLButtonElement>('.color-select-btn')!;
      await fireEvent.click(btn); // open
      await fireEvent.click(btn); // toggle closed
      hoverProbe(probe);
      vi.advanceTimersByTime(500);
      expect(document.body.querySelector('.vsg-tooltip')).not.toBeNull();
    } finally {
      unmount();
      vi.useRealTimers();
      document.body.innerHTML = '';
    }
  });

  it('renders the warning panel for the currently-selected option only when it carries warning text', () => {
    const optsWithWarn = [
      { value: 'safe', label: 'safe', color: '#4caf50' },
      { value: 'hard', label: 'hard', color: '#f44336', warning: 'Destructive — will discard changes' },
    ];
    const { container, rerender } = render(ColorSelect, {
      options: optsWithWarn, value: 'safe', onChange: vi.fn(),
    });
    expect(container.querySelector('.warning-message')).toBeNull();

    rerender({ options: optsWithWarn, value: 'hard', onChange: vi.fn() });
    const warn = container.querySelector('.warning-message');
    expect(warn?.textContent).toContain('Destructive');
  });
});
