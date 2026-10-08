import { z } from "zod";
import { buildOAuthProtectedResourceMetadata } from "@modelcontextprotocol/server";
import {
  draftScopes,
  scopesSchema,
  scopes as supportedScopes,
  type Scope,
} from "../shared/contracts";
import type { Database } from "./database";
import { audit, type Actor } from "./auth";
import { digest, future, id, secret } from "./crypto";
import { ApiError, requireValue } from "./errors";
import type { AgentRow } from "./schema";

export class OAuthError extends ApiError {
  constructor(code: string, description: string, status = 400) {
    super(status, code, description);
  }
}
function check(
  value: unknown,
  code: string,
  description: string,
): asserts value {
  if (!value) throw new OAuthError(code, description);
}
const allScopes = [...supportedScopes];
export const resource = (origin: string) => origin + "/mcp";
export const challenge = (
  origin: string,
  error?: string,
  scopes = draftScopes,
) =>
  `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="${scopes.join(" ")}"${error ? `, error="${error}", error_description="Reconnect musegod.ai with the required permissions"` : ""}`;
export function authorizationMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: origin + "/oauth/authorize",
    token_endpoint: origin + "/oauth/token",
    registration_endpoint: origin + "/oauth/register",
    revocation_endpoint: origin + "/oauth/revoke",
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: allScopes,
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: false,
  };
}
export function protectedMetadata(origin: string) {
  return buildOAuthProtectedResourceMetadata({
    resourceServerUrl: new URL(resource(origin)),
    oauthMetadata: authorizationMetadata(origin),
    scopesSupported: allScopes,
    serviceDocumentationUrl: new URL(origin + "/agents/mcp"),
  });
}
function scopes(
  value: string | undefined,
  fallback: Scope[] = draftScopes,
): Scope[] {
  const result = scopesSchema.safeParse(
    value === undefined ? fallback : value.split(" "),
  );
  check(
    result.success,
    "invalid_scope",
    "Request draft permissions and only supported scopes.",
  );
  return result.data;
}
export function parameters(params: URLSearchParams, allowed: string[]) {
  const data: Record<string, string> = {};
  for (const [key, value] of params) {
    check(
      allowed.includes(key) && !(key in data) && value.length <= 2048,
      "invalid_request",
      "Invalid or repeated OAuth parameter.",
    );
    data[key] = value;
  }
  return data;
}
type Client = { id: string; name: string; redirect_uris: string[] };
const clientSchema = z.object({
  client_name: z.string().trim().min(1).max(80).default("MCP client"),
  redirect_uris: z.array(z.string().min(1).max(2048)).min(1).max(10),
  grant_types: z
    .array(z.enum(["authorization_code", "refresh_token"]))
    .default(["authorization_code"]),
  response_types: z.array(z.literal("code")).default(["code"]),
  token_endpoint_auth_method: z.literal("none").default("none"),
  scope: z.string().max(500).optional(),
});
export async function registerClient(
  db: Database,
  input: unknown,
  origin: string,
) {
  const parsed = clientSchema.safeParse(input);
  check(
    parsed.success,
    "invalid_client_metadata",
    "Use a public OAuth client with code flow and exact callback URLs.",
  );
  const value = parsed.data;
  check(
    value.grant_types.includes("authorization_code") &&
      value.response_types.length === 1,
    "invalid_client_metadata",
    "The authorization code flow is required.",
  );
  if (value.scope !== undefined) scopes(value.scope);
  for (const uri of value.redirect_uris) {
    let url: URL;
    try {
      url = new URL(uri);
    } catch {
      throw new OAuthError("invalid_redirect_uri", "Invalid callback URL.");
    }
    const local =
      new URL(origin).protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    check(
      (url.protocol === "https:" || (local && url.protocol === "http:")) &&
        !url.username &&
        !url.password &&
        !url.hash &&
        !uri.includes("*") &&
        url.href === uri,
      "invalid_redirect_uri",
      "Use an exact HTTPS callback without credentials or a fragment.",
    );
  }
  const clientId = id("client");
  await db.query(
    "INSERT INTO musecity.oauth_clients(id,name,redirect_uris) VALUES($1,$2,$3)",
    [clientId, value.client_name, JSON.stringify(value.redirect_uris)],
  );
  return {
    ...value,
    // The registration response is authoritative; this server supports both.
    grant_types: ["authorization_code", "refresh_token"],
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
  };
}
type AuthorizationRequest = {
  id: string;
  client_id: string;
  redirect_uri: string;
  state: string | null;
  resource: string;
  code_challenge: string;
  requested_scopes: Scope[];
  approved_scopes: Scope[] | null;
  name: string | null;
  owner_account_id: string | null;
  status: string;
  expires_at: Date;
  code_hash: string | null;
};
export async function begin(
  db: Database,
  query: URLSearchParams,
  origin: string,
) {
  const p = parameters(query, [
    "response_type",
    "client_id",
    "redirect_uri",
    "scope",
    "state",
    "resource",
    "code_challenge",
    "code_challenge_method",
  ]);
  check(
    p.response_type === "code",
    "unsupported_response_type",
    "Use the authorization code flow.",
  );
  const client = await db.one<Client>(
    "SELECT * FROM musecity.oauth_clients WHERE id=$1",
    [p.client_id],
  );
  check(client, "invalid_client", "Register this OAuth client first.");
  check(
    client.redirect_uris.includes(p.redirect_uri),
    "invalid_request",
    "The callback does not match the registered client.",
  );
  check(
    p.resource === resource(origin),
    "invalid_target",
    "Request the musegod.ai MCP resource.",
  );
  check(
    p.code_challenge_method === "S256" &&
      /^[A-Za-z0-9_-]{43}$/.test(p.code_challenge ?? ""),
    "invalid_request",
    "S256 PKCE is required.",
  );
  const requested = scopes(p.scope);
  const requestId = id("oauth");
  await db.query(
    "INSERT INTO musecity.oauth_requests(id,client_id,redirect_uri,state,resource,code_challenge,requested_scopes,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
    [
      requestId,
      client.id,
      p.redirect_uri,
      p.state ?? null,
      p.resource,
      p.code_challenge,
      JSON.stringify(requested),
      future(600),
    ],
  );
  return origin + "/agents/connect?request=" + requestId;
}
async function pending(db: Database, requestId: string) {
  const request = await db.one<AuthorizationRequest>(
    "SELECT * FROM musecity.oauth_requests WHERE id=$1 FOR UPDATE",
    [requestId],
  );
  requireValue(
    request,
    404,
    "NOT_FOUND",
    "Connection request not found. Start again in your MCP client.",
  );
  requireValue(
    request.expires_at > new Date(),
    410,
    "OAUTH_EXPIRED",
    "This connection request expired. Start again in your MCP client.",
  );
  requireValue(
    request.status === "pending",
    409,
    "OAUTH_COMPLETED",
    "This request was already completed. Return to your MCP client.",
  );
  return request;
}
export async function preview(db: Database, a: Actor, requestId: string) {
  const request = await pending(db, requestId);
  const client = (await db.one<Client>(
    "SELECT * FROM musecity.oauth_clients WHERE id=$1",
    [request.client_id],
  ))!;
  const agent = await db.one<AgentRow>(
    "SELECT a.* FROM musecity.oauth_grants g JOIN musecity.agents a ON a.id=g.agent_id WHERE g.owner_account_id=$1 AND g.client_id=$2 AND a.status<>'revoked'",
    [a.account.id, client.id],
  );
  return {
    requestId,
    clientName: client.name,
    redirectOrigin: new URL(request.redirect_uri).origin,
    requestedScopes: request.requested_scopes,
    expiresAt: request.expires_at.toISOString(),
    agent: agent
      ? { id: agent.id, name: agent.name, scopes: agent.scopes }
      : null,
  };
}
function redirect(
  request: AuthorizationRequest,
  origin: string,
  values: Record<string, string>,
) {
  const url = new URL(request.redirect_uri);
  for (const key of ["code", "error", "error_description", "state", "iss"])
    url.searchParams.delete(key);
  for (const [key, value] of Object.entries(values))
    url.searchParams.set(key, value);
  url.searchParams.set("iss", origin);
  if (request.state !== null) url.searchParams.set("state", request.state);
  return { redirectUrl: url.href };
}
export async function consent(
  db: Database,
  a: Actor,
  requestId: string,
  origin: string,
  input?: { name: string; approvedScopes: Scope[] },
) {
  const request = await pending(db, requestId);
  if (!input) {
    await db.query(
      "UPDATE musecity.oauth_requests SET status='denied',owner_account_id=$2 WHERE id=$1",
      [requestId, a.account.id],
    );
    return redirect(request, origin, {
      error: "access_denied",
      error_description: "The owner declined this connection.",
    });
  }
  check(
    input.approvedScopes.every((s) => request.requested_scopes.includes(s)),
    "invalid_scope",
    "Approve only requested permissions.",
  );
  const code = secret("mc_code");
  await db.query(
    "UPDATE musecity.oauth_requests SET status='approved',owner_account_id=$2,name=$3,approved_scopes=$4,code_hash=$5,expires_at=$6 WHERE id=$1",
    [
      requestId,
      a.account.id,
      input.name,
      JSON.stringify(input.approvedScopes),
      await digest(code),
      future(300),
    ],
  );
  await audit(db, a, "oauth.approve", requestId);
  return redirect(request, origin, { code });
}
type Grant = {
  id: string;
  client_id: string;
  owner_account_id: string;
  agent_id: string;
  resource: string;
  scopes: Scope[];
  version: number;
  expires_at: Date;
  revoked_at: Date | null;
};
async function lockOwner(db: Database, ownerId: string) {
  const owner = await db.one<{ status: string }>(
    "SELECT status FROM musecity.accounts WHERE id=$1 FOR UPDATE",
    [ownerId],
  );
  check(
    owner?.status === "active",
    "invalid_grant",
    "The owner account is unavailable.",
  );
}
async function issue(db: Database, grant: Grant, approved: Scope[]) {
  const token = secret("mco");
  const refreshToken = secret("mc_refresh");
  const expiresAt = new Date(
    Math.min(Date.now() + 3600000, grant.expires_at.getTime()),
  );
  await db.query(
    "INSERT INTO musecity.credentials(id,agent_id,token_hash,prefix,expires_at,oauth_grant_id,oauth_version,oauth_scopes) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
    [
      id("cred"),
      grant.agent_id,
      await digest(token),
      token.slice(0, 12),
      expiresAt,
      grant.id,
      grant.version,
      JSON.stringify(approved),
    ],
  );
  await db.query(
    "INSERT INTO musecity.oauth_refresh_tokens(id,grant_id,version,token_hash,scopes,expires_at) VALUES($1,$2,$3,$4,$5,$6)",
    [
      id("refresh"),
      grant.id,
      grant.version,
      await digest(refreshToken),
      JSON.stringify(approved),
      new Date(
        Math.min(Date.now() + 30 * 86400000, grant.expires_at.getTime()),
      ),
    ],
  );
  return {
    access_token: token,
    token_type: "Bearer",
    expires_in: Math.floor((expiresAt.getTime() - Date.now()) / 1000),
    refresh_token: refreshToken,
    scope: approved.join(" "),
  };
}
export async function pkce(verifier: string) {
  const bytes = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
export async function exchange(
  db: Database,
  p: Record<string, string>,
  origin: string,
) {
  check(
    p.resource === resource(origin),
    "invalid_target",
    "Request the musegod.ai MCP resource.",
  );
  check(p.client_id, "invalid_client", "Supply the registered client id.");
  if (p.grant_type === "authorization_code") {
    check(
      /^[A-Za-z0-9._~-]{43,128}$/.test(p.code_verifier ?? ""),
      "invalid_grant",
      "Invalid PKCE verifier.",
    );
    const hint = await db.one<AuthorizationRequest>(
      "SELECT * FROM musecity.oauth_requests WHERE code_hash=$1",
      [await digest(p.code ?? "")],
    );
    check(
      hint?.owner_account_id,
      "invalid_grant",
      "Invalid authorization code.",
    );
    await lockOwner(db, hint.owner_account_id);
    const request = (await db.one<AuthorizationRequest>(
      "SELECT * FROM musecity.oauth_requests WHERE id=$1 FOR UPDATE",
      [hint.id],
    ))!;
    check(
      request.status === "approved" &&
        request.expires_at > new Date() &&
        request.client_id === p.client_id &&
        request.redirect_uri === p.redirect_uri &&
        request.resource === p.resource &&
        request.code_challenge === (await pkce(p.code_verifier)),
      "invalid_grant",
      "The code expired or does not match this client, callback or verifier.",
    );
    let grant = await db.one<Grant>(
      "SELECT * FROM musecity.oauth_grants WHERE owner_account_id=$1 AND client_id=$2",
      [request.owner_account_id, request.client_id],
    );
    let agent = grant
      ? await db.one<AgentRow>(
          "SELECT * FROM musecity.agents WHERE id=$1 FOR UPDATE",
          [grant.agent_id],
        )
      : undefined;
    if (agent?.status === "paused")
      throw new OAuthError(
        "invalid_grant",
        "Resume this Agent in musegod.ai before reconnecting.",
      );
    if (!agent || agent.status === "revoked") {
      const count = await db.one<{ n: string }>(
        "SELECT count(*) AS n FROM musecity.agents WHERE owner_account_id=$1 AND status<>'revoked'",
        [request.owner_account_id],
      );
      check(
        Number(count?.n) < 20,
        "invalid_grant",
        "The account has reached its 20-Agent limit.",
      );
      const agentId = id("agt");
      agent = (await db.one<AgentRow>(
        "INSERT INTO musecity.agents(id,owner_account_id,name,scopes) VALUES($1,$2,$3,$4) RETURNING *",
        [
          agentId,
          request.owner_account_id,
          request.name,
          JSON.stringify(request.approved_scopes),
        ],
      ))!;
    } else {
      await db.query(
        "UPDATE musecity.agents SET name=$2,scopes=$3 WHERE id=$1",
        [agent.id, request.name, JSON.stringify(request.approved_scopes)],
      );
    }
    if (grant) await revokeGrant(db, grant.id, false);
    grant = (await db.one<Grant>(
      `INSERT INTO musecity.oauth_grants(id,client_id,owner_account_id,agent_id,resource,scopes,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT(owner_account_id,client_id) DO UPDATE SET agent_id=excluded.agent_id,resource=excluded.resource,scopes=excluded.scopes,version=musecity.oauth_grants.version+1,expires_at=excluded.expires_at,revoked_at=NULL,connected_at=NULL RETURNING *`,
      [
        id("grant"),
        request.client_id,
        request.owner_account_id,
        agent.id,
        p.resource,
        JSON.stringify(request.approved_scopes),
        future(90 * 86400),
      ],
    ))!;
    await db.query(
      "UPDATE musecity.oauth_requests SET status='exchanged' WHERE id=$1",
      [request.id],
    );
    return issue(db, grant, request.approved_scopes!);
  }
  check(
    p.grant_type === "refresh_token",
    "unsupported_grant_type",
    "Use code exchange or refresh.",
  );
  const hint = await db.one<{
    id: string;
    owner_account_id: string;
    grant_id: string;
  }>(
    "SELECT t.id,t.grant_id,g.owner_account_id FROM musecity.oauth_refresh_tokens t JOIN musecity.oauth_grants g ON g.id=t.grant_id WHERE t.token_hash=$1",
    [await digest(p.refresh_token ?? "")],
  );
  check(hint, "invalid_grant", "Invalid refresh token.");
  await lockOwner(db, hint.owner_account_id);
  const grantHint = (await db.one<Grant>(
    "SELECT * FROM musecity.oauth_grants WHERE id=$1",
    [hint.grant_id],
  ))!;
  const agent = await db.one<AgentRow>(
    "SELECT * FROM musecity.agents WHERE id=$1 FOR UPDATE",
    [grantHint.agent_id],
  );
  const grant = (await db.one<Grant>(
    "SELECT * FROM musecity.oauth_grants WHERE id=$1 FOR UPDATE",
    [hint.grant_id],
  ))!;
  const saved = (await db.one<{
    version: number;
    used_at: Date | null;
    scopes: Scope[];
    expires_at: Date;
  }>("SELECT * FROM musecity.oauth_refresh_tokens WHERE id=$1 FOR UPDATE", [
    hint.id,
  ]))!;
  check(
    grant.client_id === p.client_id &&
      grant.resource === p.resource &&
      saved.version === grant.version,
    "invalid_grant",
    "This token is not valid for this connection.",
  );
  if (saved.used_at) {
    // Return after the transaction commits: throwing here would undo replay revocation.
    await revokeGrant(db, grant.id);
    return {
      error: "invalid_grant",
      error_description: "Refresh token already used. Reconnect musegod.ai.",
    };
  }
  check(
    !grant.revoked_at &&
      grant.expires_at > new Date() &&
      saved.expires_at > new Date() &&
      agent?.status === "active",
    "invalid_grant",
    "Reconnect musegod.ai or resume this Agent.",
  );
  const available = saved.scopes.filter(
    (s) => grant.scopes.includes(s) && agent.scopes.includes(s),
  );
  const requested = scopes(p.scope, available);
  check(
    requested.every((s) => available.includes(s)),
    "invalid_scope",
    "Refresh cannot increase permissions.",
  );
  await db.query(
    "UPDATE musecity.oauth_refresh_tokens SET used_at=now() WHERE id=$1",
    [hint.id],
  );
  return issue(db, grant, requested);
}
export async function revokeGrant(
  db: Database,
  grantId: string,
  invalidateApprovals = true,
) {
  await db.query(
    "UPDATE musecity.oauth_grants SET revoked_at=now() WHERE id=$1",
    [grantId],
  );
  await db.query(
    "UPDATE musecity.credentials SET revoked_at=now() WHERE oauth_grant_id=$1 AND revoked_at IS NULL",
    [grantId],
  );
  if (invalidateApprovals)
    await db.query(
      `UPDATE musecity.oauth_requests r SET status='denied' WHERE r.status='approved' AND EXISTS(
      SELECT 1 FROM musecity.oauth_grants g WHERE g.id=$1 AND g.owner_account_id=r.owner_account_id AND g.client_id=r.client_id)`,
      [grantId],
    );
}
export async function revoke(db: Database, p: Record<string, string>) {
  check(
    p.client_id && p.token,
    "invalid_request",
    "Supply token and client_id.",
  );
  const hash = await digest(p.token);
  const hint = await db.one<Grant>(
    `SELECT g.* FROM musecity.oauth_grants g WHERE g.client_id=$1 AND (
    EXISTS(SELECT 1 FROM musecity.credentials c WHERE c.oauth_grant_id=g.id AND c.oauth_version=g.version AND c.token_hash=$2 AND c.revoked_at IS NULL AND c.expires_at>clock_timestamp())
    OR EXISTS(SELECT 1 FROM musecity.oauth_refresh_tokens t WHERE t.grant_id=g.id AND t.version=g.version AND t.token_hash=$2 AND t.used_at IS NULL AND t.expires_at>clock_timestamp()))`,
    [p.client_id, hash],
  );
  if (hint) {
    await lockOwner(db, hint.owner_account_id);
    await db.query("SELECT id FROM musecity.agents WHERE id=$1 FOR UPDATE", [
      hint.agent_id,
    ]);
    const current = await db.one<Grant>(
      "SELECT * FROM musecity.oauth_grants WHERE id=$1 FOR UPDATE",
      [hint.id],
    );
    if (current?.version === hint.version) {
      const valid = await db.one<{ valid: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM musecity.credentials c WHERE c.oauth_grant_id=$1 AND c.oauth_version=$2 AND c.token_hash=$3 AND c.revoked_at IS NULL AND c.expires_at>clock_timestamp()) OR
        EXISTS(SELECT 1 FROM musecity.oauth_refresh_tokens t WHERE t.grant_id=$1 AND t.version=$2 AND t.token_hash=$3 AND t.used_at IS NULL AND t.expires_at>clock_timestamp()) AS valid`,
        [hint.id, current.version, hash],
      );
      if (valid?.valid) await revokeGrant(db, hint.id);
    }
  }
}
export async function connection(db: Database, agentId: string) {
  const value = await db.one<{
    name: string;
    connected_at: Date | null;
    revoked_at: Date | null;
    expires_at: Date;
  }>(
    "SELECT c.name,g.connected_at,g.revoked_at,g.expires_at FROM musecity.oauth_grants g JOIN musecity.oauth_clients c ON c.id=g.client_id WHERE g.agent_id=$1",
    [agentId],
  );
  return value
    ? {
        clientName: value.name,
        status:
          value.revoked_at || value.expires_at <= new Date()
            ? "revoked"
            : value.connected_at
              ? "connected"
              : "authorized",
        connectedAt: value.connected_at?.toISOString() ?? null,
      }
    : null;
}
export async function markConnected(db: Database, token: string) {
  await db.query(
    "UPDATE musecity.oauth_grants g SET connected_at=coalesce(connected_at,now()) WHERE g.revoked_at IS NULL AND EXISTS(SELECT 1 FROM musecity.credentials c WHERE c.oauth_grant_id=g.id AND c.oauth_version=g.version AND c.token_hash=$1 AND c.revoked_at IS NULL AND c.expires_at>now())",
    [await digest(token)],
  );
}
