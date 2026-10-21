type LovableErrorOptions = {
  mechanism?: 'manual' | 'onerror' | 'unhandledrejection' | 'react_error_boundary';
  handled?: boolean;
  severity?: 'error' | 'warning' | 'info';
};

type LovableEvents = {
  track?: (event: string, properties?: Record<string, unknown>) => string | null;
  captureException?: (
    error: unknown,
    context?: Record<string, unknown>,
    options?: LovableErrorOptions,
  ) => void;
};

declare global {
  interface Window {
    __lovableEvents?: LovableEvents;
    __lovableReportRuntimeError?: (payload: {
      message: string;
      stack?: string;
      filename?: string;
    }) => void;
  }
}

// Loaders and server fns commonly throw a raw Response; String(it) is the
// opaque "[object Response]", so pull out the status and URL instead.
function runtimeErrorMessage(error: unknown): string {
  if (error instanceof Response) {
    const location = error.url ? ` at ${error.url}` : '';
    return `Response ${error.status}${location}`;
  }
  if (error instanceof Error) return error.message;
  return String(error);
}

export function reportLovableError(error: unknown, context: Record<string, unknown> = {}) {
  if (typeof window === 'undefined') return;
  window.__lovableEvents?.captureException?.(
    error,
    {
      source: 'react_error_boundary',
      route: window.location.pathname,
      ...context,
    },
    {
      mechanism: 'react_error_boundary',
      handled: false,
      severity: 'error',
    },
  );
  // Prod React does not rethrow boundary-caught errors to window.onerror, so the
  // editor's telemetry never sees them. Forward to lovable.js's reporting hook,
  // which is present only inside the editor preview.
  const message = runtimeErrorMessage(error);
  const stack = error instanceof Error ? error.stack : undefined;
  window.__lovableReportRuntimeError?.({
    message,
    ...(stack !== undefined && { stack }),
    filename: window.location.pathname,
  });
}
