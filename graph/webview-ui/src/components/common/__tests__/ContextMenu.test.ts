import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@testing-library/svelte';
import ContextMenu from '../ContextMenu.svelte';

describe('ContextMenu', () => {
  it('renders one button per non-separator item', () => {
    const { container } = render(ContextMenu, {
      x: 0, y: 0,
      onClose: vi.fn(),
      items: [
        { label: 'Open', action: vi.fn() },
        { label: 'Copy', action: vi.fn() },
        { label: 'Delete', action: vi.fn(), danger: true },
      ],
    });
    expect(container.querySelectorAll('button.menu-item').length).toBe(3);
  });

  it('renders separators as <div class="separator">, not buttons', () => {
    const { container } = render(ContextMenu, {
      x: 0, y: 0,
      onClose: vi.fn(),
      items: [
        { label: 'A', action: vi.fn() },
        { label: '', action: vi.fn(), separator: true },
        { label: 'B', action: vi.fn() },
      ],
    });
    expect(container.querySelectorAll('button.menu-item').length).toBe(2);
    expect(container.querySelectorAll('.separator').length).toBe(1);
  });

  it('applies .danger class to items flagged danger', () => {
    const { container } = render(ContextMenu, {
      x: 0, y: 0,
      onClose: vi.fn(),
      items: [
        { label: 'Safe', action: vi.fn() },
        { label: 'Wipe', action: vi.fn(), danger: true },
      ],
    });
    const danger = container.querySelector('button.menu-item.danger');
    expect(danger?.textContent?.trim()).toBe('Wipe');
  });

  it('clicking an item invokes its action and then onClose', async () => {
    const action = vi.fn();
    const onClose = vi.fn();
    const { container } = render(ContextMenu, {
      x: 0, y: 0,
      onClose,
      items: [{ label: 'Run', action }],
    });
    await fireEvent.click(container.querySelector<HTMLButtonElement>('button.menu-item')!);
    expect(action).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('disabled items render the disabled attribute (browser ignores their clicks)', () => {
    const action = vi.fn();
    const { container } = render(ContextMenu, {
      x: 0, y: 0,
      onClose: vi.fn(),
      items: [{ label: 'Cannot', action, disabled: true }],
    });
    const btn = container.querySelector<HTMLButtonElement>('button.menu-item');
    expect(btn!.disabled).toBe(true);
  });

  it('Escape key triggers onClose', async () => {
    const onClose = vi.fn();
    render(ContextMenu, {
      x: 0, y: 0,
      onClose,
      items: [{ label: 'X', action: vi.fn() }],
    });
    await fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('mousedown outside the menu triggers onClose', async () => {
    const onClose = vi.fn();
    render(ContextMenu, {
      x: 0, y: 0,
      onClose,
      items: [{ label: 'X', action: vi.fn() }],
    });
    // Click on document.body (which is outside the .context-menu element).
    await fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('mousedown inside the menu does NOT trigger onClose', async () => {
    const onClose = vi.fn();
    const { container } = render(ContextMenu, {
      x: 0, y: 0,
      onClose,
      items: [{ label: 'X', action: vi.fn() }],
    });
    const menu = container.querySelector<HTMLDivElement>('.context-menu')!;
    await fireEvent.mouseDown(menu);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('renders submenu wrapper for items with children but does NOT eagerly render the submenu', () => {
    const { container } = render(ContextMenu, {
      x: 0, y: 0,
      onClose: vi.fn(),
      items: [
        {
          label: 'More',
          action: vi.fn(),
          children: [
            { label: 'Sub A', action: vi.fn() },
            { label: 'Sub B', action: vi.fn() },
          ],
        },
      ],
    });
    expect(container.querySelector('.submenu-wrapper')).not.toBeNull();
    expect(container.querySelector('button.has-children')).not.toBeNull();
    // Submenu only appears on hover — confirm it is hidden initially.
    expect(container.querySelector('.submenu')).toBeNull();
  });

  it('renders item icon when icon prop is provided', () => {
    const { container } = render(ContextMenu, {
      x: 0, y: 0,
      onClose: vi.fn(),
      items: [{ label: 'Copy', action: vi.fn(), icon: 'copy' }],
    });
    expect(container.querySelector('.menu-item .codicon-copy')).not.toBeNull();
  });

  it('renders child icons inside submenu items', async () => {
    const { container } = render(ContextMenu, {
      x: 0, y: 0,
      onClose: vi.fn(),
      items: [
        {
          label: 'More',
          action: vi.fn(),
          children: [{ label: 'Sub', action: vi.fn(), icon: 'trash' }],
        },
      ],
    });
    const parent = container.querySelector<HTMLButtonElement>('button.has-children')!;
    await fireEvent.mouseEnter(parent);
    expect(container.querySelector('.submenu .codicon-trash')).not.toBeNull();
  });

  it('clamps adjustedX when menu would overflow the viewport right edge', async () => {
    Object.defineProperty(window, 'innerWidth', { value: 800, writable: true, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 600, writable: true, configurable: true });
    // Stub getBoundingClientRect on the prototype BEFORE mount so the $effect
    // reads the overflowing size on its first run.
    const origRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      return { x: 0, y: 0, top: 0, left: 0, right: 200, bottom: 30, width: 200, height: 30, toJSON() {} };
    };
    try {
      const { container } = render(ContextMenu, {
        x: 750, y: 100,
        onClose: vi.fn(),
        items: [{ label: 'Open', action: vi.fn() }],
      });
      await new Promise(r => queueMicrotask(() => r(null)));
      const menu = container.querySelector<HTMLDivElement>('.context-menu')!;
      const left = parseFloat(menu.style.left);
      expect(left).toBeLessThanOrEqual(596);
    } finally {
      Element.prototype.getBoundingClientRect = origRect;
    }
  });

  it('clamps adjustedY when menu would overflow the viewport bottom', async () => {
    Object.defineProperty(window, 'innerWidth', { value: 800, writable: true, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: 600, writable: true, configurable: true });
    const origRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      return { x: 0, y: 0, top: 0, left: 0, right: 200, bottom: 300, width: 200, height: 300, toJSON() {} };
    };
    try {
      const { container } = render(ContextMenu, {
        x: 100, y: 580,
        onClose: vi.fn(),
        items: [{ label: 'Open', action: vi.fn() }],
      });
      await new Promise(r => queueMicrotask(() => r(null)));
      const menu = container.querySelector<HTMLDivElement>('.context-menu')!;
      const top = parseFloat(menu.style.top);
      expect(top).toBeLessThanOrEqual(296);
    } finally {
      Element.prototype.getBoundingClientRect = origRect;
    }
  });

  it('flips submenu to the left side when right would overflow', async () => {
    Object.defineProperty(window, 'innerWidth', { value: 800, writable: true, configurable: true });
    const { container } = render(ContextMenu, {
      x: 0, y: 0,
      onClose: vi.fn(),
      items: [
        { label: 'More', action: vi.fn(), children: [{ label: 'Sub', action: vi.fn() }] },
      ],
    });
    const parent = container.querySelector<HTMLButtonElement>('button.has-children')!;
    // Stub wrapper rect so right + 190 > 800
    const wrapper = parent.closest('.submenu-wrapper') as HTMLElement;
    wrapper.getBoundingClientRect = () => ({
      x: 0, y: 0, top: 0, left: 700, right: 700, bottom: 30, width: 100, height: 30, toJSON() {},
    });
    await fireEvent.mouseEnter(parent);
    const submenu = container.querySelector('.submenu');
    expect(submenu?.classList.contains('on-left')).toBe(true);
  });

  it('mouseleave from submenu-wrapper clears activeSubmenu', async () => {
    const { container } = render(ContextMenu, {
      x: 0, y: 0,
      onClose: vi.fn(),
      items: [
        {
          label: 'More',
          action: vi.fn(),
          children: [{ label: 'Sub', action: vi.fn() }],
        },
      ],
    });
    const parent = container.querySelector<HTMLButtonElement>('button.has-children')!;
    await fireEvent.mouseEnter(parent);
    expect(container.querySelector('.submenu')).not.toBeNull();
    const wrapper = container.querySelector<HTMLDivElement>('.submenu-wrapper')!;
    await fireEvent.mouseLeave(wrapper);
    expect(container.querySelector('.submenu')).toBeNull();
  });

  it('clicking a submenu child invokes its action and closes the parent menu', async () => {
    const childAction = vi.fn();
    const onClose = vi.fn();
    const { container } = render(ContextMenu, {
      x: 0, y: 0,
      onClose,
      items: [
        {
          label: 'More',
          action: vi.fn(),
          children: [{ label: 'Sub', action: childAction }],
        },
      ],
    });
    // Open submenu by hovering the parent.
    const parent = container.querySelector<HTMLButtonElement>('button.has-children')!;
    await fireEvent.mouseEnter(parent);
    const child = container.querySelector<HTMLButtonElement>('.submenu .menu-item');
    expect(child).not.toBeNull();
    await fireEvent.click(child!);
    expect(childAction).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
