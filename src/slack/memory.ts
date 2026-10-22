/**
 * In-process stand-ins for the Slack doors — used by tests and by anything
 * that must run without a workspace. Same contracts as the real drivers.
 */
import type {
  HistoryMessage,
  SlackConversation,
  SlackDirectory,
  SlackHistory,
  SlackListener,
  SlackMessageEvent,
} from './types';

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
  /** Drops the line (`connected()` turns false) or brings it back (runs `onConnected`). */
  setConnected(connected: boolean): void;
}

export function createMemoryListener(): MemoryListener {
  let handler: ((event: SlackMessageEvent) => void) | undefined;
  let onConnected: (() => void) | undefined;
  let live = false;
  return {
    start(onMessage, connected) {
      handler = onMessage;
      onConnected = connected;
      live = true;
      onConnected?.();
      return Promise.resolve();
    },
    connected: () => live,
    stop() {
      handler = undefined;
      live = false;
      return Promise.resolve();
    },
    emit(event) {
      handler?.(event);
    },
    setConnected(connected) {
      live = connected;
      if (connected) onConnected?.();
    },
  };
}

/** History held in memory: every message ever "posted", by conversation. */
export interface MemoryHistory extends SlackHistory {
  /** Posts a message into history (the ears are not told — that is the point). */
  post(message: HistoryMessage, type?: SlackConversation['type']): void;
  /** How many reads were made — so tests can see what a poll costs. */
  readonly reads: number;
}

const newer = (ts: string, oldest: string) => Number(ts) > Number(oldest);
const byTs = (a: { ts: string }, b: { ts: string }) => Number(a.ts) - Number(b.ts);

export function createMemoryHistory(): MemoryHistory {
  const conversations = new Map<string, SlackConversation>();
  const messages: HistoryMessage[] = [];
  let reads = 0;
  return {
    get reads() {
      return reads;
    },
    post(message, type = message.channelType) {
      if (!conversations.has(message.channel)) {
        conversations.set(message.channel, { id: message.channel, type });
      }
      messages.push(message);
    },
    conversations() {
      reads += 1;
      return Promise.resolve([...conversations.values()]);
    },
    messagesSince(conversation, oldest) {
      reads += 1;
      const found = messages
        .filter(
          (m) =>
            m.channel === conversation.id &&
            newer(m.ts, oldest) &&
            (m.threadTs === undefined || m.threadTs === m.ts || m.subtype === 'thread_broadcast'),
        )
        .map((m) => {
          const replies = messages.filter(
            (r) => r.channel === m.channel && r.threadTs === m.ts && r.ts !== m.ts,
          );
          const latest = replies.sort(byTs).at(-1)?.ts;
          return latest === undefined ? m : { ...m, latestReply: latest };
        });
      return Promise.resolve(found.sort(byTs));
    },
    repliesSince(conversation, threadTs, oldest) {
      reads += 1;
      return Promise.resolve(
        messages
          .filter(
            (m) =>
              m.channel === conversation.id &&
              m.threadTs === threadTs &&
              m.ts !== threadTs &&
              newer(m.ts, oldest),
          )
          .sort(byTs),
      );
    },
  };
}
