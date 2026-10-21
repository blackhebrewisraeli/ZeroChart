import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Click handler for a modal backdrop: closes only when the backdrop itself is
 * clicked, and stops every click inside the portal from reaching the
 * components rendered behind it. Escape closes the modals for keyboard users.
 */
export function closeOnBackdrop(close: () => void) {
  return (event: React.MouseEvent) => {
    event.stopPropagation();
    if (event.target === event.currentTarget) close();
  };
}
