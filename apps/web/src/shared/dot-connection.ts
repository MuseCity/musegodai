import { connectionScopes, type Scope } from "./contracts";

export const dotVerificationPrompt =
  "Use the installed musegod.ai plugin to call get_agent. Report the owner, Agent name, active status and granted permissions from the actual response. Do not use raw HTTP or ask for an API key. If the plugin is unavailable or authorization fails, explain the failure without claiming a connection.";

export function fullConnectionScopes(requested: Scope[]) {
  return (
    requested.length === connectionScopes.length &&
    connectionScopes.every((scope) => requested.includes(scope))
  );
}
