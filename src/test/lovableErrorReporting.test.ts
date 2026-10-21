import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { reportLovableError } from '@/lib/lovable-error-reporting';

describe('reportLovableError', () => {
  const report = vi.fn();
  const captureException = vi.fn();

  beforeEach(() => {
    window.history.replaceState(null, '', '/markets');
    window.__lovableReportRuntimeError = report;
    window.__lovableEvents = { captureException };
  });

  afterEach(() => {
    delete window.__lovableReportRuntimeError;
    delete window.__lovableEvents;
    vi.clearAllMocks();
  });

  function reportedPayload() {
    expect(report).toHaveBeenCalledTimes(1);
    return report.mock.calls[0]?.[0];
  }

  it('forwards an Error message and stack', () => {
    const error = new Error('boom');
    error.stack = 'Error: boom\n    at loader (route.ts:1:1)';
    reportLovableError(error);
    expect(reportedPayload()).toStrictEqual({
      message: 'boom',
      stack: 'Error: boom\n    at loader (route.ts:1:1)',
      filename: '/markets',
    });
  });

  it('omits the stack key when an Error has no stack', () => {
    const error = new Error('no trace');
    delete error.stack;
    reportLovableError(error);
    expect(reportedPayload()).toStrictEqual({ message: 'no trace', filename: '/markets' });
  });

  it('forwards a thrown string as-is', () => {
    reportLovableError('plain failure');
    expect(reportedPayload()).toStrictEqual({ message: 'plain failure', filename: '/markets' });
  });

  it.each([
    [42, '42'],
    [null, 'null'],
    [undefined, 'undefined'],
    [{ code: 'E_FAIL' }, '[object Object]'],
  ])('stringifies the non-Error value %p', (value, message) => {
    reportLovableError(value);
    expect(reportedPayload()).toStrictEqual({ message, filename: '/markets' });
  });

  it('summarizes a thrown Response with its status and URL', () => {
    const response = new Response(null, { status: 404 });
    Object.defineProperty(response, 'url', { value: 'https://api.example.test/assets' });
    reportLovableError(response);
    expect(reportedPayload()).toStrictEqual({
      message: 'Response 404 at https://api.example.test/assets',
      filename: '/markets',
    });
  });

  it('summarizes a thrown Response without a URL', () => {
    reportLovableError(new Response(null, { status: 500 }));
    expect(reportedPayload()).toStrictEqual({ message: 'Response 500', filename: '/markets' });
  });

  it('passes the raw error and merged context to captureException', () => {
    const error = new Error('boom');
    reportLovableError(error, { boundary: 'tanstack_root_error_component' });
    expect(captureException.mock.calls).toStrictEqual([
      [
        error,
        {
          source: 'react_error_boundary',
          route: '/markets',
          boundary: 'tanstack_root_error_component',
        },
        { mechanism: 'react_error_boundary', handled: false, severity: 'error' },
      ],
    ]);
  });
});
