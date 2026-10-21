import { describe, expect, it, vi } from 'vitest';
import type { MouseEvent } from 'react';
import { closeOnBackdrop } from '@/lib/utils';

function clickOn(target: object, currentTarget: object) {
  const stopPropagation = vi.fn();
  return {
    event: { target, currentTarget, stopPropagation } as unknown as MouseEvent,
    stopPropagation,
  };
}

describe('closeOnBackdrop', () => {
  it('closes when the backdrop itself is clicked', () => {
    const close = vi.fn();
    const backdrop = {};
    const { event, stopPropagation } = clickOn(backdrop, backdrop);

    closeOnBackdrop(close)(event);

    expect(close).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
  });

  it('keeps the modal open for clicks inside the dialog, and still stops them', () => {
    const close = vi.fn();
    const { event, stopPropagation } = clickOn({}, {});

    closeOnBackdrop(close)(event);

    expect(close).not.toHaveBeenCalled();
    expect(stopPropagation).toHaveBeenCalledOnce();
  });
});
