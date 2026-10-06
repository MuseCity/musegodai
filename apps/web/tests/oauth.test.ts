import { createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  Client,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
} from "@modelcontextprotocol/client";
import { draftScopes, type Scope } from "../src/shared/contracts";
import { withDatabase } from "../src/server/database";
import { assertLocalTarget } from "../scripts/local-target";
import { article, config, fixture, reset } from "./helpers";

const origin = "http://localhost";
const resource = origin + "/mcp";
const redirectUri = "http://127.0.0.1:4179/oauth/callback";
const clients: Client[] = [];
type Fixture = ReturnType<typeof fixture>;
type Pending = {
  clientId: string;
  verifier: string;
  state: string;
  requestId: string;
  redirectUri: string;
};

beforeEach(async () => {
  await reset();
  await admin("TRUNCATE musecity.oauth_clients CASCADE", []);
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

async function admin(query: string, values: unknown[]) {
  assertLocalTarget(config.testAdminUrl, "musecity_test", "musecity_admin");
  return withDatabase(config.testAdminUrl, (db) => db.query(query, values));
}

async function raw(
  f: Fixture,
  path: string,
  {
    method = "GET",
    body,
    form,
  }: {
    method?: string;
    body?: unknown;
    form?: Record<string, string>;
  } = {},
) {
  const response = await f.app.request(origin + path, {
    method,
    headers:
      body !== undefined
        ? { "Content-Type": "application/json" }
        : form
          ? { "Content-Type": "application/x-www-form-urlencoded" }
          : {},
    body:
      body !== undefined
        ? JSON.stringify(body)
        : form
          ? new URLSearchParams(form).toString()
          : undefined,
  });
  const data = response.headers
    .get("content-type")
    ?.includes("application/json")
    ? ((await response.json()) as any)
    : null;
  return { response, status: response.status, data };
}

async function register(f: Fixture, callback = redirectUri) {
  const metadata = {
    client_name: "Local OAuth acceptance " + crypto.randomUUID(),
    redirect_uris: [callback],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
  const registered = await raw(f, "/oauth/register", {
    method: "POST",
    body: metadata,
  });
  expect(registered.status).toBe(201);
  expect(registered.data).toMatchObject(metadata);
  expect(registered.data.client_id).toEqual(expect.any(String));
  expect(registered.data).not.toHaveProperty("client_secret");
  return { id: registered.data.client_id as string, metadata };
}

function authorizeQuery(clientId: string, requestedScopes?: Scope[]) {
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(20).toString("base64url");
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    resource,
    ...(requestedScopes ? { scope: requestedScopes.join(" ") } : {}),
  });
  return { query, verifier, state };
}

async function begin(f: Fixture, clientId?: string, requestedScopes?: Scope[]) {
  const registered = clientId ? { id: clientId } : await register(f);
  const { query, verifier, state } = authorizeQuery(
    registered.id,
    requestedScopes,
  );
  const authorization = await raw(f, "/oauth/authorize?" + query);
  expect(authorization.status).toBe(302);
  const next = new URL(authorization.response.headers.get("location")!, origin);
  expect(next.origin).toBe(origin);
  expect(next.pathname).toBe("/agents/connect");
  const requestId = next.searchParams.get("request");
  expect(requestId).toEqual(expect.any(String));
  return {
    clientId: registered.id,
    verifier,
    state,
    requestId: requestId!,
    redirectUri,
  };
}

async function approve(
  f: Fixture,
  pending: Pending,
  approvedScopes: Scope[] = draftScopes,
  owner = "alice",
) {
  const approved = await f.call(
    `/oauth/requests/${pending.requestId}/approve`,
    {
      token: "fixture:" + owner,
      method: "POST",
      body: { name: "OAuth assistant", approvedScopes, confirmed: true },
    },
  );
  expect(approved.status).toBe(200);
  expect(Object.keys(approved.data)).toEqual(["redirectUrl"]);
  const callback = new URL(approved.data.redirectUrl);
  expect(callback.origin + callback.pathname).toBe(pending.redirectUri);
  expect(callback.searchParams.get("state")).toBe(pending.state);
  expect(callback.searchParams.get("iss")).toBe(origin);
  expect(callback.searchParams.get("code")).toEqual(expect.any(String));
  expect(callback.searchParams.has("access_token")).toBe(false);
  expect(callback.searchParams.has("refresh_token")).toBe(false);
  return callback.searchParams.get("code")!;
}

async function exchange(f: Fixture, pending: Pending, code: string) {
  return raw(f, "/oauth/token", {
    method: "POST",
    form: {
      grant_type: "authorization_code",
      client_id: pending.clientId,
      redirect_uri: pending.redirectUri,
      code_verifier: pending.verifier,
      code,
      resource,
    },
  });
}

async function authorized(f: Fixture, requestedScopes?: Scope[]) {
  const pending = await begin(f, undefined, requestedScopes);
  const code = await approve(f, pending, requestedScopes ?? draftScopes);
  const issued = await exchange(f, pending, code);
  expect(issued.status).toBe(200);
  expect(issued.data.token_type).toBe("Bearer");
  expect(issued.data.expires_in).toBeGreaterThanOrEqual(3598);
  expect(issued.data.expires_in).toBeLessThanOrEqual(3600);
  expect(issued.data.access_token).toMatch(/^mco_/);
  expect(issued.data.refresh_token).toMatch(/^mc_refresh_/);
  expect(issued.data.scope.split(" ")).toEqual(requestedScopes ?? draftScopes);
  return { pending, tokens: issued.data };
}

async function refresh(
  f: Fixture,
  pending: Pending,
  token: string,
  scope?: string,
) {
  return raw(f, "/oauth/token", {
    method: "POST",
    form: {
      grant_type: "refresh_token",
      client_id: pending.clientId,
      refresh_token: token,
      resource,
      ...(scope === undefined ? {} : { scope }),
    },
  });
}

async function connect(f: Fixture, token: string) {
  const client = new Client({ name: "musecity-oauth-tests", version: "1.0.0" });
  clients.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(new URL(resource), {
      requestInit: { headers: { Authorization: "Bearer " + token } },
      fetch: async (url, init) => f.app.fetch(new Request(url, init)),
    }),
  );
  return client;
}

async function tool(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.find((item) => item.type === "text");
  if (!text || text.type !== "text") throw new Error("Missing MCP tool result");
  return { result, data: JSON.parse(text.text) };
}

describe("OAuth MCP authorization with real local PostgreSQL", () => {
  it("connects through the SDK OAuth provider's discovery, registration and callback flow", async () => {
    const f = fixture();
    const state = randomBytes(20).toString("base64url");
    let storedClient: StoredOAuthClientInformation | undefined;
    let storedTokens: StoredOAuthTokens | undefined;
    let discovery: OAuthDiscoveryState | undefined;
    let verifier: string | undefined;
    let authorizationUrl: URL | undefined;
    const provider: OAuthClientProvider = {
      redirectUrl: redirectUri,
      clientMetadata: {
        client_name: "Musecity SDK OAuth acceptance",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: draftScopes.join(" "),
      },
      state: () => state,
      clientInformation: () => storedClient,
      saveClientInformation: (value) => {
        storedClient = value;
      },
      tokens: () => storedTokens,
      saveTokens: (value) => {
        storedTokens = value;
      },
      redirectToAuthorization: (value) => {
        authorizationUrl = value;
      },
      saveCodeVerifier: (value) => {
        verifier = value;
      },
      codeVerifier: () => {
        if (!verifier)
          throw new Error("The SDK did not persist its PKCE verifier");
        return verifier;
      },
      discoveryState: () => discovery,
      saveDiscoveryState: (value) => {
        discovery = value;
      },
    };
    const visited: string[] = [];
    const transport = () =>
      new StreamableHTTPClientTransport(new URL(resource), {
        authProvider: provider,
        fetch: async (url, init) => {
          const request = new Request(url, init);
          visited.push(request.method + " " + new URL(request.url).pathname);
          return f.app.fetch(request);
        },
      });
    const first = new Client({ name: "musecity-sdk-oauth", version: "1.0.0" });
    clients.push(first);
    const firstTransport = transport();
    await expect(first.connect(firstTransport)).rejects.toBeInstanceOf(
      UnauthorizedError,
    );
    expect(visited).toEqual(
      expect.arrayContaining([
        "GET /.well-known/oauth-protected-resource/mcp",
        "GET /.well-known/oauth-authorization-server",
        "POST /oauth/register",
      ]),
    );
    expect(storedClient?.issuer).toBe(origin);
    expect(storedClient?.client_id).toEqual(expect.any(String));
    expect(storedTokens).toBeUndefined();
    expect(discovery?.authorizationServerMetadata?.issuer).toBe(origin);
    expect(authorizationUrl?.origin).toBe(origin);
    expect(authorizationUrl?.pathname).toBe("/oauth/authorize");
    expect(authorizationUrl?.searchParams.get("resource")).toBe(resource);
    expect(authorizationUrl?.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    expect(authorizationUrl?.searchParams.get("scope")?.split(" ")).toEqual(
      draftScopes,
    );
    const redirect = await raw(
      f,
      authorizationUrl!.pathname + authorizationUrl!.search,
    );
    expect(redirect.status).toBe(302);
    const requestId = new URL(
      redirect.response.headers.get("location")!,
      origin,
    ).searchParams.get("request")!;
    const approved = await f.call(`/oauth/requests/${requestId}/approve`, {
      method: "POST",
      body: {
        name: "SDK-connected Agent",
        approvedScopes: draftScopes,
        confirmed: true,
      },
    });
    expect(approved.status).toBe(200);
    const callback = new URL(approved.data.redirectUrl);
    expect(callback.searchParams.get("state")).toBe(state);
    // The SDK validates the callback issuer and owns the entire token request;
    // the host checks state before passing callback parameters to finishAuth.
    await firstTransport.finishAuth(callback.searchParams);
    expect(visited).toContain("POST /oauth/token");
    expect(storedTokens?.issuer).toBe(origin);
    expect(storedTokens?.access_token).toMatch(/^mco_/);
    expect(storedTokens?.refresh_token).toMatch(/^mc_refresh_/);
    const connected = new Client({
      name: "musecity-sdk-oauth",
      version: "1.0.0",
    });
    clients.push(connected);
    await connected.connect(transport());
    const identity = await tool(connected, "get_agent");
    expect(identity.data).toMatchObject({
      httpStatus: 200,
      status: "active",
      scopes: draftScopes,
    });
    const created = await tool(connected, "create_creation", {
      content: article,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(created.data).toMatchObject({ httpStatus: 201, status: "draft" });
    expect(
      (
        await tool(connected, "get_creation", {
          id: created.data.workId,
          draft: true,
        })
      ).data.workId,
    ).toBe(created.data.workId);
  });

  it("discovers authorization endpoints and sends an MCP resource challenge", async () => {
    const f = fixture();
    const server = await raw(f, "/.well-known/oauth-authorization-server");
    expect(server.status).toBe(200);
    expect(server.data).toMatchObject({
      issuer: origin,
      authorization_endpoint: origin + "/oauth/authorize",
      token_endpoint: origin + "/oauth/token",
      registration_endpoint: origin + "/oauth/register",
      revocation_endpoint: origin + "/oauth/revoke",
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
    });
    for (const path of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ]) {
      const metadata = await raw(f, path);
      expect(metadata.status).toBe(200);
      expect(metadata.data).toMatchObject({
        resource,
        authorization_servers: [origin],
      });
    }
    const response = await f.app.request(resource, { method: "POST" });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      `resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
    );
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("registers public clients while refusing insecure redirect destinations", async () => {
    const f = fixture();
    await register(f);
    await register(f, "https://client.example/oauth/callback");
    for (const callback of [
      "http://client.example/oauth/callback",
      "https://client.example/callback#fragment",
      "https://user:password@client.example/callback",
      "javascript:alert(1)",
    ]) {
      const invalid = await raw(f, "/oauth/register", {
        method: "POST",
        body: {
          client_name: "Invalid redirect",
          redirect_uris: [callback],
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
        },
      });
      expect(invalid.status).toBe(400);
    }
  });

  it("requires PKCE S256 and the exact registered callback and MCP resource", async () => {
    const f = fixture(),
      registered = await register(f);
    const changes: Record<string, string | null>[] = [
      { code_challenge: null },
      { code_challenge_method: "plain" },
      { redirect_uri: redirectUri + "?substituted=1" },
      { resource: null },
      { resource: "https://other.example/mcp" },
      { response_type: "token" },
      { scope: "accounts:write" },
    ];
    for (const change of changes) {
      const { query } = authorizeQuery(registered.id);
      for (const [key, value] of Object.entries(change))
        if (value === null) query.delete(key);
        else query.set(key, value);
      const invalid = await raw(f, "/oauth/authorize?" + query);
      expect(invalid.status).toBe(400);
      expect(invalid.response.headers.has("location")).toBe(false);
    }
  });

  it("requires human consent, defaults to private drafts and exposes no credentials in approval", async () => {
    const f = fixture(),
      pending = await begin(f);
    const preview = await f.call(`/oauth/requests/${pending.requestId}`);
    expect(preview.status).toBe(200);
    expect(preview.data).toMatchObject({
      requestId: pending.requestId,
      redirectOrigin: "http://127.0.0.1:4179",
      requestedScopes: draftScopes,
      agent: null,
    });
    expect(preview.data.clientName).toEqual(expect.any(String));
    expect(Date.parse(preview.data.expiresAt)).toBeGreaterThan(Date.now());
    expect(
      (await f.call(`/oauth/requests/${pending.requestId}`, { token: null }))
        .status,
    ).toBe(401);
    for (const body of [
      { name: "OAuth assistant", approvedScopes: draftScopes },
      {
        name: "OAuth assistant",
        approvedScopes: draftScopes,
        confirmed: false,
      },
      {
        name: "OAuth assistant",
        approvedScopes: [...draftScopes, "content:publish"],
        confirmed: true,
      },
    ]) {
      const rejected = await f.call(
        `/oauth/requests/${pending.requestId}/approve`,
        {
          method: "POST",
          body,
        },
      );
      expect(rejected.status).toBe(400);
    }
    const code = await approve(f, pending);
    const token = await exchange(f, pending, code);
    expect(token.status).toBe(200);
    expect(token.response.headers.get("cache-control")).toContain("no-store");
    const repeated = await exchange(f, pending, code);
    expect(repeated.status).toBe(400);
    expect(repeated.data.error).toBe("invalid_grant");
  });

  it("returns a state-bound denial without creating an Agent", async () => {
    const f = fixture(),
      pending = await begin(f);
    const denied = await f.call(`/oauth/requests/${pending.requestId}/deny`, {
      method: "POST",
      body: {},
    });
    expect(denied.status).toBe(200);
    const callback = new URL(denied.data.redirectUrl);
    expect(callback.origin + callback.pathname).toBe(redirectUri);
    expect(callback.searchParams.get("error")).toBe("access_denied");
    expect(callback.searchParams.get("state")).toBe(pending.state);
    expect(callback.searchParams.get("iss")).toBe(origin);
    expect(callback.searchParams.has("code")).toBe(false);
    expect((await f.call("/me/agents")).data).toHaveLength(0);
    expect(
      (
        await f.call(`/oauth/requests/${pending.requestId}/approve`, {
          method: "POST",
          body: {
            name: "Too late",
            approvedScopes: draftScopes,
            confirmed: true,
          },
        })
      ).status,
    ).toBeGreaterThanOrEqual(400);
  });

  it("binds code redemption to PKCE, resource, callback and client", async () => {
    const f = fixture(),
      registered = await register(f),
      other = await register(f);
    for (const change of [
      { code_verifier: randomBytes(32).toString("base64url") },
      { resource: "https://other.example/mcp" },
      { redirect_uri: redirectUri + "?changed=1" },
      { client_id: other.id },
    ]) {
      const pending = await begin(f, registered.id),
        code = await approve(f, pending);
      const rejected = await raw(f, "/oauth/token", {
        method: "POST",
        form: {
          grant_type: "authorization_code",
          client_id: pending.clientId,
          redirect_uri: pending.redirectUri,
          code_verifier: pending.verifier,
          code,
          resource,
          ...change,
        },
      });
      expect(rejected.status).toBe(400);
      expect(rejected.data).not.toHaveProperty("access_token");
    }
  });

  it("runs the first MCP identity and private draft workflow while rejecting REST token use", async () => {
    const f = fixture(),
      { tokens } = await authorized(f);
    const direct = await f.call("/agent", { token: tokens.access_token });
    expect(direct.status).toBe(403);
    expect(direct.data.error.code).toBe("MCP_ONLY");
    const client = await connect(f, tokens.access_token);
    const tools = await client.listTools();
    const [ownerAgent] = (await f.call("/me/agents")).data;
    expect(ownerAgent.oauthConnection).toMatchObject({
      status: "authorized",
      connectedAt: null,
    });
    expect(tools.tools.map((item) => item.name)).toEqual(
      expect.arrayContaining([
        "get_agent",
        "create_creation",
        "get_creation",
        "publish_creation",
        "list_feed",
      ]),
    );
    const security = tools.tools.find(
      (item) => item.name === "create_creation",
    ) as any;
    expect(security.securitySchemes ?? security._meta?.securitySchemes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "oauth2", scopes: ["content:write"] }),
      ]),
    );
    const identity = await tool(client, "get_agent");
    expect(identity.data).toMatchObject({
      status: "active",
      scopes: draftScopes,
    });
    expect(
      (await f.call(`/me/agents/${identity.data.id}`)).data.oauthConnection,
    ).toMatchObject({ status: "connected", connectedAt: expect.any(String) });
    const content = { content: article, idempotencyKey: crypto.randomUUID() };
    const created = await tool(client, "create_creation", content);
    expect(created.data).toMatchObject({ httpStatus: 201, status: "draft" });
    expect((await tool(client, "create_creation", content)).data.workId).toBe(
      created.data.workId,
    );
    expect(
      (
        await tool(client, "get_creation", {
          id: created.data.workId,
          draft: true,
        })
      ).data.workId,
    ).toBe(created.data.workId);
    expect(
      (await f.call(`/works/${created.data.workId}`, { token: null })).status,
    ).toBe(404);
    const publish = await tool(client, "publish_creation", {
      id: created.data.workId,
      revisionId: created.data.revisionId,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(publish.data.error.code).toBe("SCOPE_DENIED");
    expect(publish.result._meta?.["mcp/www_authenticate"]).toEqual(
      expect.any(Array),
    );
    const challenge = (
      publish.result._meta?.["mcp/www_authenticate"] as string[]
    )[0];
    expect(challenge).toContain('error="insufficient_scope"');
    expect(challenge.match(/scope="([^"]+)"/)?.[1].split(" ")).toEqual(
      expect.arrayContaining([...draftScopes, "content:publish"]),
    );
    expect(JSON.stringify(tools)).not.toContain(tokens.access_token);
  });

  it("expires authorization requests and codes without granting a connection", async () => {
    const f = fixture(),
      pending = await begin(f);
    await admin(
      "UPDATE musecity.oauth_requests SET expires_at=now()-interval '1 second' WHERE id=$1",
      [pending.requestId],
    );
    expect((await f.call(`/oauth/requests/${pending.requestId}`)).status).toBe(
      410,
    );
    expect(
      (
        await f.call(`/oauth/requests/${pending.requestId}/approve`, {
          method: "POST",
          body: {
            name: "Expired",
            approvedScopes: draftScopes,
            confirmed: true,
          },
        })
      ).status,
    ).toBe(410);
    const approved = await begin(f),
      code = await approve(f, approved);
    await admin(
      "UPDATE musecity.oauth_requests SET expires_at=now()-interval '1 second' WHERE id=$1",
      [approved.requestId],
    );
    const expired = await exchange(f, approved, code);
    expect(expired.status).toBe(400);
    expect(expired.data.error).toBe("invalid_grant");
    expect((await f.call("/me/agents")).data).toHaveLength(0);
  });

  it("expires access, refresh and grant permissions at the database boundary", async () => {
    const f = fixture(),
      { pending, tokens } = await authorized(f);
    const client = await connect(f, tokens.access_token),
      identity = await tool(client, "get_agent");
    await admin(
      "UPDATE musecity.credentials SET expires_at=now()-interval '1 second' WHERE agent_id=$1 AND oauth_grant_id IS NOT NULL",
      [identity.data.id],
    );
    await expect(tool(client, "get_agent")).rejects.toThrow();
    const renewed = await refresh(f, pending, tokens.refresh_token);
    expect(renewed.status).toBe(200);
    const active = await connect(f, renewed.data.access_token);
    expect((await tool(active, "get_agent")).data.id).toBe(identity.data.id);
    await admin(
      "UPDATE musecity.oauth_refresh_tokens SET expires_at=now()-interval '1 second' WHERE grant_id IN (SELECT id FROM musecity.oauth_grants WHERE agent_id=$1)",
      [identity.data.id],
    );
    expect((await refresh(f, pending, renewed.data.refresh_token)).status).toBe(
      400,
    );
    await admin(
      "UPDATE musecity.oauth_grants SET expires_at=now()-interval '1 second' WHERE agent_id=$1",
      [identity.data.id],
    );
    await expect(tool(active, "get_agent")).rejects.toThrow();
    expect(
      (await f.call(`/me/agents/${identity.data.id}`)).data.oauthConnection
        .status,
    ).toBe("revoked");
  });

  it("keeps a verified Move-in connection complete after its short-lived access token expires", async () => {
    const f = fixture(),
      { tokens } = await authorized(f);
    expect((await f.call("/me/onboarding")).data.muse.status).toBe(
      "awaiting_activation",
    );
    const identity = await tool(
      await connect(f, tokens.access_token),
      "get_agent",
    );
    expect((await f.call("/me/onboarding")).data.muse.status).toBe("activated");
    await admin(
      "UPDATE musecity.credentials SET expires_at=now()-interval '1 second' WHERE agent_id=$1 AND oauth_grant_id IS NOT NULL",
      [identity.data.id],
    );
    expect((await f.call("/me/onboarding")).data.muse.status).toBe("activated");
  });

  it("consumes a code once under concurrent exchange", async () => {
    const f = fixture(),
      pending = await begin(f),
      code = await approve(f, pending);
    const exchanged = await Promise.all([
      exchange(f, pending, code),
      exchange(f, pending, code),
    ]);
    expect(exchanged.map((entry) => entry.status).sort()).toEqual([200, 400]);
    expect((await f.call("/me/agents")).data).toHaveLength(1);
  });

  it("reuses an owner's Agent on reconnect while isolating another owner's consent", async () => {
    const f = fixture(),
      { pending, tokens } = await authorized(f);
    const first = await tool(
      await connect(f, tokens.access_token),
      "get_agent",
    );
    const reconnect = await begin(f, pending.clientId);
    const preview = await f.call(`/oauth/requests/${reconnect.requestId}`);
    expect(preview.data.agent.id).toBe(first.data.id);
    const nextCode = await approve(f, reconnect);
    const next = await exchange(f, reconnect, nextCode);
    expect(next.status).toBe(200);
    expect(
      (await tool(await connect(f, next.data.access_token), "get_agent")).data
        .id,
    ).toBe(first.data.id);
    expect((await f.call("/me/agents")).data).toHaveLength(1);
    const other = await begin(f, pending.clientId);
    const otherPreview = await f.call(`/oauth/requests/${other.requestId}`, {
      token: "fixture:bob",
    });
    expect(otherPreview.data.agent).toBe(null);
    const otherCode = await approve(f, other, draftScopes, "bob");
    const otherTokens = await exchange(f, other, otherCode);
    const otherIdentity = await tool(
      await connect(f, otherTokens.data.access_token),
      "get_agent",
    );
    expect(otherIdentity.data.id).not.toBe(first.data.id);
    expect(otherIdentity.data.owner.id).not.toBe(first.data.owner.id);
    expect(
      (await f.call(`/me/agents/${first.data.id}`, { token: "fixture:bob" }))
        .status,
    ).toBe(404);
  });

  it("rotates refresh tokens and rejects scope escalation", async () => {
    const f = fixture(),
      { pending, tokens } = await authorized(f);
    const increased = await refresh(
      f,
      pending,
      tokens.refresh_token,
      [...draftScopes, "content:publish"].join(" "),
    );
    expect(increased.status).toBe(400);
    expect(increased.data.error).toBe("invalid_scope");
    const wrongResource = await raw(f, "/oauth/token", {
      method: "POST",
      form: {
        grant_type: "refresh_token",
        client_id: pending.clientId,
        refresh_token: tokens.refresh_token,
        resource: "https://other.example/mcp",
      },
    });
    expect(wrongResource.status).toBe(400);
    const rotated = await refresh(f, pending, tokens.refresh_token);
    expect(rotated.status).toBe(200);
    expect(rotated.data.refresh_token).not.toBe(tokens.refresh_token);
    expect(rotated.data.access_token).not.toBe(tokens.access_token);
    expect(
      (await tool(await connect(f, rotated.data.access_token), "get_agent"))
        .data.httpStatus,
    ).toBe(200);
    const replay = await refresh(f, pending, tokens.refresh_token);
    expect(replay.status).toBe(400);
    expect(replay.data.error).toBe("invalid_grant");
    expect((await refresh(f, pending, rotated.data.refresh_token)).status).toBe(
      400,
    );
    await expect(connect(f, rotated.data.access_token)).rejects.toThrow();
    await expect(connect(f, tokens.access_token)).rejects.toThrow();
  });

  it("does not let refresh replay or revocation from an old connection revoke a reconnected version", async () => {
    const f = fixture(),
      { pending, tokens } = await authorized(f);
    const rotated = await refresh(f, pending, tokens.refresh_token);
    expect(rotated.status).toBe(200);
    const reconnect = await begin(f, pending.clientId),
      code = await approve(f, reconnect);
    const renewed = await exchange(f, reconnect, code);
    expect(renewed.status).toBe(200);
    expect((await refresh(f, pending, tokens.refresh_token)).status).toBe(400);
    for (const old of [
      tokens.refresh_token,
      tokens.access_token,
      rotated.data.refresh_token,
    ]) {
      expect(
        (
          await raw(f, "/oauth/revoke", {
            method: "POST",
            form: { token: old, client_id: pending.clientId },
          })
        ).status,
      ).toBe(200);
    }
    expect(
      (await tool(await connect(f, renewed.data.access_token), "get_agent"))
        .data.httpStatus,
    ).toBe(200);
    expect(
      (await refresh(f, reconnect, renewed.data.refresh_token)).status,
    ).toBe(200);
  });

  it.each(["reduce", "credentials/rotate", "revoke"])(
    "rejects an unredeemed approved code after owner control: %s",
    async (action) => {
      const permissions: Scope[] = [...draftScopes, "content:publish"];
      const f = fixture(),
        { pending, tokens } = await authorized(f, permissions);
      const identity = await tool(
        await connect(f, tokens.access_token),
        "get_agent",
      );
      const reconnect = await begin(f, pending.clientId, permissions),
        code = await approve(f, reconnect, permissions);
      const changed =
        action === "reduce"
          ? await f.call(`/me/agents/${identity.data.id}`, {
              method: "PATCH",
              body: { scopes: draftScopes, confirmed: true },
            })
          : await f.call(`/me/agents/${identity.data.id}/${action}`, {
              method: "POST",
              body: { confirmed: true },
            });
      expect(changed.status).toBe(200);
      const rejected = await exchange(f, reconnect, code);
      expect(rejected.status).toBe(400);
      expect(rejected.data.error).toBe("invalid_grant");
      expect(rejected.data).not.toHaveProperty("access_token");
    },
  );

  it("keeps current Agent permission reductions authoritative for existing OAuth tokens", async () => {
    const permissions: Scope[] = [...draftScopes, "content:publish"];
    const f = fixture(),
      { pending, tokens } = await authorized(f, permissions);
    const client = await connect(f, tokens.access_token),
      identity = await tool(client, "get_agent");
    const created = await tool(client, "create_creation", {
      content: article,
      idempotencyKey: crypto.randomUUID(),
    });
    expect(
      (
        await f.call(`/me/agents/${identity.data.id}`, {
          method: "PATCH",
          body: { scopes: draftScopes, confirmed: true },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await tool(client, "publish_creation", {
          id: created.data.workId,
          revisionId: created.data.revisionId,
          idempotencyKey: crypto.randomUUID(),
        })
      ).data.error.code,
    ).toBe("SCOPE_DENIED");
    const renewed = await refresh(f, pending, tokens.refresh_token);
    expect(renewed.status).toBe(200);
    expect(renewed.data.scope.split(" ")).toEqual(draftScopes);
  });

  it("blocks refresh while paused and invalidates OAuth tokens on owner rotation and revocation", async () => {
    const f = fixture(),
      { pending, tokens } = await authorized(f);
    const client = await connect(f, tokens.access_token),
      identity = await tool(client, "get_agent");
    const manage = (action: string) =>
      f.call(`/me/agents/${identity.data.id}/${action}`, {
        method: "POST",
        body: { confirmed: true },
      });
    expect((await manage("pause")).status).toBe(200);
    expect((await tool(client, "get_agent")).data.status).toBe("paused");
    expect((await tool(client, "list_tags")).data.error.code).toBe(
      "AGENT_PAUSED",
    );
    expect((await refresh(f, pending, tokens.refresh_token)).status).toBe(400);
    expect((await manage("resume")).status).toBe(200);
    expect((await tool(client, "list_tags")).data.httpStatus).toBe(200);
    expect((await manage("credentials/rotate")).status).toBe(200);
    await expect(tool(client, "get_agent")).rejects.toThrow();
    expect((await refresh(f, pending, tokens.refresh_token)).status).toBe(400);
    const reconnected = await begin(f, pending.clientId),
      code = await approve(f, reconnected);
    const renewed = await exchange(f, reconnected, code);
    expect(renewed.status).toBe(200);
    expect((await manage("revoke")).status).toBe(200);
    await expect(connect(f, renewed.data.access_token)).rejects.toThrow();
    expect(
      (await refresh(f, reconnected, renewed.data.refresh_token)).status,
    ).toBe(400);
  });

  it("returns 200 for inactive token revocation without revoking its current grant", async () => {
    const f = fixture();
    for (const state of [
      "expired-access",
      "revoked-access",
      "used-refresh",
      "expired-refresh",
    ]) {
      const { pending, tokens } = await authorized(f);
      let currentAccess = tokens.access_token;
      let inactive = tokens.refresh_token;
      if (state !== "expired-refresh") {
        const rotated = await refresh(f, pending, tokens.refresh_token);
        expect(rotated.status).toBe(200);
        currentAccess = rotated.data.access_token;
      }
      if (state === "expired-access" || state === "revoked-access") {
        inactive = tokens.access_token;
        await admin(
          "UPDATE musecity.credentials SET " +
            (state === "expired-access"
              ? "expires_at=now()-interval '1 second'"
              : "revoked_at=now()") +
            " WHERE token_hash=$1",
          [createHash("sha256").update(inactive).digest("hex")],
        );
      } else if (state === "expired-refresh") {
        await admin(
          "UPDATE musecity.oauth_refresh_tokens SET expires_at=now()-interval '1 second' WHERE token_hash=$1",
          [createHash("sha256").update(inactive).digest("hex")],
        );
      }
      const ignored = await raw(f, "/oauth/revoke", {
        method: "POST",
        form: { token: inactive, client_id: pending.clientId },
      });
      expect(ignored.status).toBe(200);
      const identity = await tool(await connect(f, currentAccess), "get_agent");
      expect(identity.data.httpStatus).toBe(200);
      expect(
        (await f.call(`/me/agents/${identity.data.id}`)).data.oauthConnection
          .status,
      ).toBe("connected");
    }
  });

  it("revokes a grant with RFC 7009 semantics without leaking unknown tokens", async () => {
    const f = fixture(),
      { pending, tokens } = await authorized(f);
    const other = await register(f);
    const wrongClient = await raw(f, "/oauth/revoke", {
      method: "POST",
      form: {
        token: tokens.refresh_token,
        client_id: other.id,
        token_type_hint: "refresh_token",
      },
    });
    expect(wrongClient.status).toBe(200);
    expect(
      (await tool(await connect(f, tokens.access_token), "get_agent")).data
        .httpStatus,
    ).toBe(200);
    const revoked = await raw(f, "/oauth/revoke", {
      method: "POST",
      form: {
        token: tokens.refresh_token,
        client_id: pending.clientId,
        token_type_hint: "refresh_token",
      },
    });
    expect(revoked.status).toBe(200);
    expect((await refresh(f, pending, tokens.refresh_token)).status).toBe(400);
    await expect(connect(f, tokens.access_token)).rejects.toThrow();
    const unknown = await raw(f, "/oauth/revoke", {
      method: "POST",
      form: { token: "mc_refresh_unknown", client_id: pending.clientId },
    });
    expect(unknown.status).toBe(200);
  });
});
