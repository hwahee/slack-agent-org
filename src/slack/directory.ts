/**
 * Read-only Slack directory over the Web API.
 *
 * Only `auth.test`, `users.info` and `conversations.info` are ever called, and
 * ESLint forbids touching the sending namespaces in this module at all. Names
 * are cached for the life of the process: people rarely rename, and a stale
 * name in a notification is harmless.
 */
import { WebClient } from '@slack/web-api';

import type { Logger } from '../lib/log';
import { findWriteScopes } from './scopes';
import type { SlackDirectory } from './types';

export function createWebDirectory(token: string, log: Logger): SlackDirectory {
  const client = new WebClient(token);
  const users = new Map<string, Promise<string>>();
  const channels = new Map<string, Promise<string>>();

  function cached(
    cache: Map<string, Promise<string>>,
    id: string,
    lookup: () => Promise<string | undefined>,
  ): Promise<string> {
    let name = cache.get(id);
    if (!name) {
      name = lookup()
        .then((found) => found ?? id)
        .catch((error: unknown) => {
          log.warn('slack lookup failed', { id, error: String(error) });
          cache.delete(id); // try again next time
          return id;
        });
      cache.set(id, name);
    }
    return name;
  }

  return {
    async assertReadOnly() {
      const result = await client.auth.test();
      const scopes = result.response_metadata?.scopes;
      if (!scopes) {
        throw new Error('Slack did not report the read token scopes; cannot prove it is read-only');
      }
      const writes = findWriteScopes(scopes);
      if (writes.length > 0) {
        throw new Error(
          `SLACK_READ_TOKEN can write (${writes.join(', ')}). Remove these scopes: ` +
            'the agent sends only through the Slack client on screen (CLAUDE.md).',
        );
      }
      log.info('slack read token verified', { user: result.user_id, team: result.team, scopes });
    },

    userName(userId) {
      return cached(users, userId, async () => {
        const { user } = await client.users.info({ user: userId });
        // Slack leaves unset names as "" — take the first one that is filled in.
        return [user?.profile?.display_name, user?.real_name, user?.name].find(
          (name) => name !== undefined && name !== '',
        );
      });
    },

    channelName(channelId) {
      return cached(channels, channelId, async () => {
        const { channel } = await client.conversations.info({ channel: channelId });
        return channel?.name;
      });
    },
  };
}
