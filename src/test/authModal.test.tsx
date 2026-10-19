import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthModal } from '@/components/AuthModal';

vi.mock('@/lib/supabaseClient', () => ({
  supabase: {
    auth: {
      signInWithPassword: vi.fn(),
      signUp: vi.fn(),
      signInWithOAuth: vi.fn(),
    },
  },
}));

afterEach(cleanup);

describe('AuthModal', () => {
  it('keeps OAuth prominent and uses one compact primary action for the email form', () => {
    const { container } = render(<AuthModal open onOpenChange={vi.fn()} />);
    const dialog = screen.getByRole('dialog', { name: 'ZeroChart account' });

    expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue with GitHub' })).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveClass('auth-input');
    expect(screen.getByLabelText('Password')).toHaveClass('auth-input');
    expect(dialog.querySelector('button[type="submit"]')).toHaveClass('auth-submit');
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    expect(dialog.querySelector('.auth-body')?.lastElementChild).toHaveClass('auth-submit');
    expect(container).toBeEmptyDOMElement();
  });
});
