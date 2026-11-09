// What test 6's and test 7's mocks of panelManager, getLocalCommands and premiumManager answer: World15 sets them.
// This file imports nothing, so a vi.mock factory can import it without a cycle.

export const stubs = {
  manager: null as any,
  commands: [] as any[],
};

export const premiumStub = {
  getTierOverrides: () => ({}),
  getGuildSubscriptionUrl: () => null,
  getMessages: () => ({ moduleBlocked: 'MODULE BLOCKED', commandBlocked: 'COMMAND BLOCKED' }),
  hasFeatureAccess: () => true,
};
