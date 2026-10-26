import { createFileRoute } from '@tanstack/react-router';
import { Workspace } from '@/components/Workspace';

// Pathless layout for `/`, `/paper-trading` and `/account`: the shell is mounted once here so
// switching zones keeps it (and its live feed) alive. It can't sit on each zone route — code
// splitting gives every route its own lazy component wrapper, so siblings sharing
// `component: Workspace` still remounted the shell on every switch.
export const Route = createFileRoute('/_workspace')({
  component: Workspace,
});
