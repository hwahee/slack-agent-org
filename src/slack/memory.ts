/**
 * In-process stand-ins for the Slack doors — used by tests and by anything
 * that must run without a workspace. Same contracts as the real drivers.
 */
import type { SlackDirectory, SlackListener, SlackMessageEvent } from './types';

export function createMemoryDirectory(
  names: { users?: Record<string, string>; channels?: Record<string, string> } = {},
): SlackDirectory {
  return {
    assertReadOnly: () => Promise.resolve([]),
    userName: (id) => Promise.resolve(names.users?.[id] ?? id),
    channelName: (id) => Promise.resolve(names.channels?.[id] ?? id),
  };
}

/** A listener whose events are pushed by hand with `emit`. */
export interface MemoryListener extends SlackListener {
  emit(event: SlackMessageEvent): void;
}

export function createMemoryListener(): MemoryListener {
  let handler: ((event: SlackMessageEvent) => void) | undefined;
  return {
    start(onMessage) {
      handler = onMessage;
      return Promise.resolve();
    },
    stop() {
      handler = undefined;
      return Promise.resolve();
    },
    emit(event) {
      handler?.(event);
    },
  };
}
