import { describe, it, expect } from 'vitest';
import { WORKBENCH_MESSAGE_EFFECTS } from '../workbench-messages';

describe('WORKBENCH_MESSAGE_EFFECTS', () => {
  it('classifies every webview message type', () => {
    // These are the only two message types B-2a defines webview→host. If a new
    // one is added without a classification, TS fails to compile the Record;
    // this test additionally guards against the record values drifting.
    expect(WORKBENCH_MESSAGE_EFFECTS.workbenchGetStatus).toBe('read');
    expect(WORKBENCH_MESSAGE_EFFECTS.workbenchCommit).toBe('mutation');
  });

  it('has no undefined effects', () => {
    for (const [type, effect] of Object.entries(WORKBENCH_MESSAGE_EFFECTS)) {
      expect(effect, `${type} must be classified`).toMatch(/^(mutation|read)$/);
    }
  });
});
