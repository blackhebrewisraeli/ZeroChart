import { afterEach, describe, expect, it } from 'vitest';
import { containDialogTab } from '@/lib/dialogFocus';

afterEach(() => {
  document.body.replaceChildren();
});

describe('containDialogTab', () => {
  it('wraps Tab and Shift+Tab within a custom dialog', () => {
    const dialog = document.createElement('dialog');
    const first = document.createElement('button');
    const last = document.createElement('button');
    dialog.append(first, last);
    document.body.append(dialog);

    last.focus();
    const forward = new KeyboardEvent('keydown', { key: 'Tab', cancelable: true });
    containDialogTab(forward, dialog);
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);

    const backward = new KeyboardEvent('keydown', {
      key: 'Tab',
      shiftKey: true,
      cancelable: true,
    });
    containDialogTab(backward, dialog);
    expect(backward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
  });
});
