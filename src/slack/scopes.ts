/**
 * Which OAuth scopes let a token change something in Slack.
 *
 * Every `<resource>:write` scope (and its sub-scopes like `chat:write.public`)
 * writes; so does an incoming webhook. The read token must hold none of them —
 * then "the agent never sends through the API" is a property of the token,
 * not only of the code.
 */
const WRITE_SCOPE = /:write(\.|$)|^incoming-webhook$/;

export function findWriteScopes(scopes: readonly string[]): string[] {
  return scopes.filter((scope) => WRITE_SCOPE.test(scope));
}
