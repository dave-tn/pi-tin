import { describe, expect, test } from 'bun:test';
import { formatRuntimeStateWarning } from './list.js';

describe('formatRuntimeStateWarning', () => {
  test('explains impact and makes stop optional', () => {
    const warning = formatRuntimeStateWarning('ctwo', {
      runtimeState: 'corrupt',
      activeSessions: [],
      shutdown: null,
      meta: null,
      warnings: [
        "Runtime metadata is missing for workspace 'ctwo'.",
      ],
    });

    expect(warning.summary).toBe(
      "Workspace 'ctwo' is running, but its runtime state could not be read.",
    );
    expect(warning.details).toEqual([
      'Sessions and shutdown status may be inaccurate.',
      "Detail: Runtime metadata is missing for workspace 'ctwo'.",
      'Optional cleanup: pi-tin stop ctwo',
    ]);
  });

  test('still renders when no specific runtime warnings are available', () => {
    const warning = formatRuntimeStateWarning('ctwo', {
      runtimeState: 'corrupt',
      activeSessions: [],
      shutdown: null,
      meta: null,
      warnings: [],
    });

    expect(warning.details).toEqual([
      'Sessions and shutdown status may be inaccurate.',
      'Optional cleanup: pi-tin stop ctwo',
    ]);
  });
});
