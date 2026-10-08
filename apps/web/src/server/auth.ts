import { PrivyClient } from "@privy-io/node";
import type { Database } from "./database";
import type { AccountRow, AgentRow } from "./schema";
import type { Scope, Profile } from "../shared/contracts";
import { digest, id } from "./crypto";
import { requireValue, ApiError } from "./errors";

export type Identity =
  | { kind: "human"; userId: string }
  | { kind: "agent"; tokenHash: string; resource?: string };
export type Actor = {
  account: AccountRow;
  agent: AgentRow | null;
  key: string;
};
export type VerifyHuman = (token: string) => Promise<string>;
// Keep only the current app's SDK/JWKS cache, never tokens or verified identities.
// productionServices is request-scoped, so this cache must outlive its closures.
let cachedPrivy:
  { appId: string; appSecret: string; client: PrivyClient } | undefined;
export function privyVerifier(appId: string, appSecret: string): VerifyHuman {
  return async (token) => {
    requireValue(
      appId && appSecret,
      503,
      "AUTH_UNAVAILABLE",
      "Sign-in is not available yet. Please try again later.",
    );
    try {
      if (
        !cachedPrivy ||
        cachedPrivy.appId !== appId ||
        cachedPrivy.appSecret !== appSecret
      )
        cachedPrivy = {
          appId,
          appSecret,
          client: new PrivyClient({ appId, appSecret }),
        };
      return (await cachedPrivy.client.utils().auth().verifyAccessToken(token))
        .user_id;
    } catch {
      throw new ApiError(
        401,
        "INVALID_CREDENTIAL",
        "Your session has expired. Please sign in again.",
      );
    }
  };
}
export async function identity(
  request: Request,
  verify: VerifyHuman,
  mcpCredential?: string,
): Promise<Identity> {
  const authorization = request.headers.get("authorization");
  requireValue(
    authorization?.startsWith("Bearer "),
    401,
    "AUTH_REQUIRED",
    "Please sign in to continue.",
  );
  // Privy also attaches a browser cookie. Only the verified Bearer token
  // determines API identity; cookies never authenticate or override a request.
  const token = authorization!.slice(7);
  requireValue(
    token.length < 10000 && !token.includes(" "),
    401,
    "INVALID_CREDENTIAL",
    "Invalid credential.",
  );
  requireValue(
    !/^bh[aricu]_/.test(token),
    401,
    "INVALID_CREDENTIAL",
    "Invalid credential.",
  );
  if (token.startsWith("mco_"))
    requireValue(
      token === mcpCredential,
      403,
      "MCP_ONLY",
      "Use this connection through the MCP client, not the REST API.",
    );
  if (/^mc[ao]_/.test(token))
    return {
      kind: "agent",
      tokenHash: await digest(token),
      resource: new URL("/mcp", request.url).href,
    };
  requireValue(
    !/^mc[ricu]_/.test(token),
    403,
    "SCOPE_DENIED",
    "A registration credential cannot access content.",
  );
  return { kind: "human", userId: await verify(token) };
}
export const profile = (a: AccountRow): Profile => ({
  id: a.id,
  handle: a.handle,
  name: a.name,
  bio: a.bio,
  avatarMediaId: a.avatar_media_id,
  workingOn: a.working_on,
  canHelp: a.can_help,
  joinedAt: a.joined_at?.toISOString() ?? null,
});

// All authenticated transactions acquire the account row before agent/work rows.
// Revocation and publishing therefore share the same commit ordering boundary.
export async function actor(
  db: Database,
  who: Identity,
  scope?: Scope,
  humanOnly = false,
  diagnostic = false,
): Promise<Actor> {
  let account: AccountRow | undefined;
  let agent: AgentRow | null = null;
  if (who.kind === "human") {
    const accountId = id("acc");
    const handle = "creator-" + accountId.slice(-10);
    await db.query(
      "INSERT INTO musecity.accounts(id,privy_user_id,handle,name) VALUES($1,$2,$3,$4) ON CONFLICT(privy_user_id) DO NOTHING",
      [accountId, who.userId, handle, "Creator"],
    );
    account = await db.one<AccountRow>(
      "SELECT * FROM musecity.accounts WHERE privy_user_id=$1 FOR UPDATE",
      [who.userId],
    );
  } else {
    requireValue(
      !humanOnly,
      403,
      "SCOPE_DENIED",
      "Only the account owner can do this.",
    );
    const hint = await db.one<{ owner_account_id: string; agent_id: string }>(
      "SELECT a.owner_account_id,a.id AS agent_id FROM musecity.credentials c JOIN musecity.agents a ON a.id=c.agent_id WHERE c.token_hash=$1",
      [who.tokenHash],
    );
    requireValue(hint, 401, "INVALID_CREDENTIAL", "Invalid agent credential.");
    account = await db.one<AccountRow>(
      "SELECT * FROM musecity.accounts WHERE id=$1 FOR UPDATE",
      [hint.owner_account_id],
    );
    agent =
      (await db.one<AgentRow>(
        "SELECT * FROM musecity.agents WHERE id=$1 FOR UPDATE",
        [hint.agent_id],
      )) ?? null;
    const credential = await db.one<{
      expires_at: Date;
      revoked_at: Date | null;
      oauth_grant_id: string | null;
      oauth_version: number | null;
      oauth_scopes: Scope[] | null;
    }>(
      "SELECT expires_at,revoked_at,oauth_grant_id,oauth_version,oauth_scopes FROM musecity.credentials WHERE token_hash=$1 FOR UPDATE",
      [who.tokenHash],
    );
    requireValue(
      credential &&
        !credential.revoked_at &&
        credential.expires_at > new Date(),
      401,
      "CREDENTIAL_REVOKED",
      "The agent credential has expired or was revoked.",
    );
    requireValue(
      agent && agent.status !== "revoked",
      401,
      "CREDENTIAL_REVOKED",
      "This agent was revoked.",
    );
    if (credential.oauth_grant_id) {
      const grant = await db.one<{
        version: number;
        resource: string;
        scopes: Scope[];
        revoked_at: Date | null;
        expires_at: Date;
      }>(
        "SELECT version,resource,scopes,revoked_at,expires_at FROM musecity.oauth_grants WHERE id=$1",
        [credential.oauth_grant_id],
      );
      requireValue(
        grant &&
          !grant.revoked_at &&
          grant.expires_at > new Date() &&
          grant.version === credential.oauth_version &&
          grant.resource === who.resource,
        401,
        "CREDENTIAL_REVOKED",
        "Reconnect musegod.ai in your MCP client.",
      );
      agent = {
        ...agent,
        scopes: agent.scopes.filter(
          (s) =>
            grant.scopes.includes(s) && credential.oauth_scopes!.includes(s),
        ),
      };
    }
    requireValue(
      agent.status === "active" || diagnostic,
      403,
      "AGENT_PAUSED",
      "This agent is paused.",
    );
    requireValue(
      !scope || agent.scopes.includes(scope),
      403,
      "SCOPE_DENIED",
      "The agent does not have permission for this action.",
    );
  }
  requireValue(account, 401, "AUTH_REQUIRED", "Please sign in again.");
  requireValue(
    account.status === "active",
    403,
    "ACCOUNT_RESTRICTED",
    "This account is restricted.",
  );
  return { account, agent, key: agent?.id ?? account.id };
}
export async function rateLimit(db: Database, key: string, limit: number) {
  const slot = Math.floor(Date.now() / 60000);
  const row = await db.one<{ counter: number }>(
    "INSERT INTO musecity.rate_limits(key,counter,expires_at) VALUES($1,1,now()+interval '2 minutes') ON CONFLICT(key) DO UPDATE SET counter=musecity.rate_limits.counter+1 RETURNING counter",
    [key + ":" + slot],
  );
  requireValue(
    row && row.counter <= limit,
    429,
    "RATE_LIMITED",
    "Too many requests. Please retry in a minute.",
  );
}
export async function audit(
  db: Database,
  a: Actor,
  action: string,
  resource: string,
) {
  await db.query(
    "INSERT INTO musecity.activity(id,owner_account_id,agent_id,action,resource_id) VALUES($1,$2,$3,$4,$5)",
    [id("evt"), a.account.id, a.agent?.id ?? null, action, resource],
  );
  if (a.agent)
    await db.query(
      "UPDATE musecity.agents SET last_active_at=now() WHERE id=$1",
      [a.agent.id],
    );
}
export async function lookupIdempotency<T>(
  db: Database,
  a: Actor,
  operation: string,
  key: string | null,
  body: unknown,
): Promise<{ hash: string; response?: T }> {
  requireValue(
    key && /^[a-zA-Z0-9_-]{8,120}$/.test(key),
    400,
    "IDEMPOTENCY_KEY_REQUIRED",
    "Supply an Idempotency-Key for this write.",
  );
  // Only the digest retains former defaults, so historical update retries stay equivalent.
  const legacyPost = (post: Record<string, unknown>) => ({
    kind: post.kind,
    text: post.text,
    title: "",
    expectedOutcome: "",
    tagIds: post.tagIds,
    mediaIds: post.mediaIds,
  });
  let hashBody = body;
  if (body && typeof body === "object") {
    const input = body as Record<string, unknown>;
    if (operation === "POST:/api/v1/posts" && input.kind === "update")
      hashBody = legacyPost(input);
    if (
      /^PATCH:\/api\/v1\/posts\/[^/]+$/.test(operation) &&
      input.content &&
      typeof input.content === "object"
    )
      hashBody = {
        revision: input.revision,
        content: legacyPost(input.content as Record<string, unknown>),
      };
  }
  const hash = await digest(JSON.stringify(hashBody));
  const saved = await db.one<{ request_hash: string; response: T }>(
    "SELECT request_hash,response FROM musecity.idempotency WHERE actor_key=$1 AND operation=$2 AND key=$3",
    [a.key, operation, key],
  );
  if (saved) {
    requireValue(
      saved.request_hash === hash,
      409,
      "IDEMPOTENCY_CONFLICT",
      "This key was used for a different request.",
    );
    // Old write snapshots may contain the retired field on a profile or owner.
    // Project only those response positions; preserve stored history and content.
    if (saved.response && typeof saved.response === "object") {
      const response = saved.response as Record<string, unknown>;
      if (
        /^(POST:\/api\/v1\/posts|PATCH:\/api\/v1\/posts\/[^/]+)$/.test(
          operation,
        ) &&
        response.kind === "update"
      ) {
        delete response.title;
        delete response.expectedOutcome;
        delete response.helpStatus;
      }
      const owner =
        operation === "PATCH:/api/v1/me" ? response : response.owner;
      if (owner && typeof owner === "object")
        delete (owner as Record<string, unknown>).ecosystems;
    }
    return { hash, response: saved.response };
  }
  return { hash };
}
export async function deduplicate<T>(
  db: Database,
  a: Actor,
  operation: string,
  key: string | null,
  body: unknown,
  perform: () => Promise<T>,
): Promise<T> {
  const record = await lookupIdempotency<T>(db, a, operation, key, body);
  if ("response" in record) return record.response!;
  const result = await perform();
  await db.query(
    "INSERT INTO musecity.idempotency(actor_key,operation,key,request_hash,response) VALUES($1,$2,$3,$4,$5)",
    [a.key, operation, key, record.hash, JSON.stringify(result)],
  );
  return result;
}

export const profileSql = (alias: string) =>
  `jsonb_build_object('id',${alias}.id,'handle',${alias}.handle,'name',${alias}.name,'bio',${alias}.bio,'avatarMediaId',${alias}.avatar_media_id,'workingOn',${alias}.working_on,'canHelp',${alias}.can_help,'joinedAt',${alias}.joined_at)`;

// Caller already owns the account lock; retries of an idempotent write do not consume again.
export async function dailyBudget(
  db: Database,
  a: Actor,
  kind: "publication" | "reply",
) {
  const slot = new Date().toISOString().slice(0, 10);
  const limit = kind === "publication" ? 20 : 100;
  const row = await db.one<{ counter: number }>(
    "INSERT INTO musecity.rate_limits(key,counter,expires_at) VALUES($1,1,now()+interval '2 days') ON CONFLICT(key) DO UPDATE SET counter=musecity.rate_limits.counter+1 RETURNING counter",
    [`community:${a.account.id}:${kind}:${slot}`],
  );
  requireValue(
    row && row.counter <= limit,
    429,
    "COMMUNITY_DAILY_LIMIT",
    `Your household has reached today's ${limit} ${kind === "publication" ? "new posts and creations" : "replies"}. Try again after 00:00 UTC.`,
  );
}
