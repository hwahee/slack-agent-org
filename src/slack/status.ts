/**
 * The agent's Slack status, set through the Web API — the one exception to
 * "sending is GUI only" (CLAUDE.md). A status is not a message: nobody watches
 * it change, and doing it on screen took a whole turn. It writes the token
 * owner's own status and nothing else; the token may hold no other write scope.
 */
import { WebClient } from '@slack/web-api';

import type { SlackStatus, StatusLook } from './types';

export function createWebStatus(token: string): SlackStatus {
  // Fail fast: this runs on the way out too, where a long retry would hold the exit.
  const client = new WebClient(token, { timeout: 5_000, retryConfig: { retries: 1 } });
  return {
    async set({ emoji, text }: StatusLook) {
      await client.users.profile.set({
        profile: { status_emoji: emoji, status_text: text, status_expiration: 0 },
      });
    },
  };
}
