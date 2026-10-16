import { Moon, Sun } from 'lucide-react';
import { useTheme } from 'next-themes';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => setMounted(true), []);

  const isDark = mounted ? resolvedTheme !== 'light' : true;

  return (
    <Button
      variant="outline"
      size="icon"
      className="header-theme h-9 w-9 flex-shrink-0"
      aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
      title="Toggle theme"
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
    >
      {isDark ? <Sun size={16} /> : <Moon size={16} />}
    </Button>
  );
}
