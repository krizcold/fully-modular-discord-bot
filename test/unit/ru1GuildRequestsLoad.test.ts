import { describe, expect, it } from 'vitest';

import { guildRequestsExiting } from '../../src/webui/utils/guildRequests';

describe('the web UI at load', () => {
  it('is not exiting before anything reset it', () => {
    expect(guildRequestsExiting()).toBe(false);
  });
});
