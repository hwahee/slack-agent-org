/**
 * Which OAuth scopes let a token change something in Slack.
 *
 * Every `<resource>:write` scope (and its sub-scopes like `chat:write.public`)
 * writes; so does an incoming webhook. The read token must hold none of them —
 * then "the agent never sends through the API" is a property of the token,
 * not only of the code.
 *
 * One exception, by decision: the agent's own Slack status (SLACK_STATUS) is
 * set through the API, because nobody watches it change and on screen it was
 * too slow. It is allowed only while SLACK_STATUS is on, and it cannot send.
 */
const WRITE_SCOPE = /:write(\.|$)|^incoming-webhook$/;

/** Lets `users.profile.set` change the token owner's status (and only profile fields). */
export const STATUS_SCOPE = 'users.profile:write';

/** Write scopes in `scopes`, other than the `allowed` ones. */
export function findWriteScopes(
  scopes: readonly string[],
  allowed: readonly string[] = [],
): string[] {
  return scopes.filter((scope) => WRITE_SCOPE.test(scope) && !allowed.includes(scope));
}

/** The write scopes the read token may hold: the status scope while SLACK_STATUS is on, else none. */
export function allowedWriteScopes(slackStatus: 'on' | 'off'): readonly string[] {
  return slackStatus === 'on' ? [STATUS_SCOPE] : [];
}
