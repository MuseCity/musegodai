// Local browser fixture and real local PostgreSQL only. No production writes.
// Run from apps/web with Node 24: node e2e/verify-oauth.mjs.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";

const origin = "http://127.0.0.1:5191";
const resource = origin + "/mcp";
const session = "musecity-oauth-" + process.pid;
const output = resolve(".local/oauth-browser");
mkdirSync(output, { recursive: true });
const checks = [];
const connections = [];
const createdWorks = [];
const createdAgents = [];
let callback;
let callbackServer;
let callbackUrl;
const scopes = ["content:read", "content:write"];
const name = "OAuth browser " + Date.now();

function browser(...args) {
  const result = JSON.parse(
    execFileSync("agent-browser", ["--session", session, "--json", ...args], {
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 2 * 1024 * 1024,
    }),
  );
  assert.ok(result.success, "Browser action failed: " + args[0]);
  return result.data;
}
const evaluate = (code) => browser("eval", code).result;
function wait(condition) {
  evaluate(
    "(async()=>{const end=Date.now()+15000;while(!(" +
      condition +
      ")){if(Date.now()>end)throw Error('Browser state did not settle');await new Promise(r=>setTimeout(r,80));}return true;})()",
  );
}
function click(text, scope = "document") {
  evaluate(
    "[..." +
      scope +
      ".querySelectorAll('button,a')].find(b=>b.textContent.trim()===" +
      JSON.stringify(text) +
      ").click()",
  );
}
function card(agentName = name) {
  return (
    "[...document.querySelectorAll('.agent-card')].find(c=>c.querySelector('h3').textContent===" +
    JSON.stringify(agentName) +
    ")"
  );
}
const dialog = "document.querySelector('dialog')";

async function request(
  path,
  { method = "GET", token, body, form, status = 200, redirect = "manual" } = {},
) {
  const response = await fetch(origin + path, {
    method,
    redirect,
    signal: AbortSignal.timeout(15000),
    headers: {
      Connection: "close",
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(body !== undefined
        ? {
            "Content-Type": "application/json",
            "Idempotency-Key": crypto.randomUUID(),
          }
        : {}),
      ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body:
      body !== undefined
        ? JSON.stringify(body)
        : form
          ? new URLSearchParams(form).toString()
          : undefined,
  });
  assert.equal(response.status, status, method + " " + path.split("?")[0]);
  const data = response.headers
    .get("content-type")
    ?.includes("application/json")
    ? await response.json()
    : null;
  return { response, data };
}
async function api(path, options = {}) {
  return (
    await request("/api/v1" + path, { token: "fixture:alice", ...options })
  ).data;
}
async function begin(clientId, requestedScopes = scopes) {
  callback = null;
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(20).toString("base64url");
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: callbackUrl,
    scope: requestedScopes.join(" "),
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    resource,
  });
  const started = await request("/oauth/authorize?" + query, { status: 302 });
  const next = new URL(started.response.headers.get("location"), origin);
  assert.equal(next.pathname, "/agents/connect");
  return {
    path: next.pathname + next.search,
    verifier,
    state,
    requestId: next.searchParams.get("request"),
  };
}
async function received(pending, denied = false) {
  const deadline = Date.now() + 15000;
  while (!callback) {
    assert.ok(Date.now() < deadline, "Client callback did not arrive");
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  assert.equal(callback.searchParams.get("state"), pending.state);
  assert.equal(callback.searchParams.get("iss"), origin);
  assert.ok(!callback.searchParams.has("access_token"));
  assert.ok(!callback.searchParams.has("refresh_token"));
  if (denied) {
    assert.equal(callback.searchParams.get("error"), "access_denied");
    assert.ok(!callback.searchParams.has("code"));
    return null;
  }
  assert.ok(
    callback.searchParams.get("code"),
    "Missing client authorization code",
  );
  return callback.searchParams.get("code");
}
async function exchange(clientId, pending, code) {
  return (
    await request("/oauth/token", {
      method: "POST",
      form: {
        grant_type: "authorization_code",
        client_id: clientId,
        redirect_uri: callbackUrl,
        code_verifier: pending.verifier,
        code,
        resource,
      },
    })
  ).data;
}
async function connect(token) {
  const client = new Client({
    name: "musecity-local-oauth-browser",
    version: "1.0.0",
  });
  connections.push(client);
  await client.connect(
    new StreamableHTTPClientTransport(new URL(resource), {
      requestInit: { headers: { Authorization: "Bearer " + token } },
    }),
  );
  return client;
}
async function tool(client, toolName, args = {}) {
  const result = await client.callTool({ name: toolName, arguments: args });
  const text = result.content?.find((item) => item.type === "text");
  assert.ok(text?.type === "text", "Missing MCP tool result");
  return JSON.parse(text.text);
}
function screenshot(label) {
  const captured = browser("screenshot");
  assert.ok(captured.path, "Browser did not return its screenshot path");
  copyFileSync(captured.path, output + "/" + label + ".png");
}

try {
  callbackServer = createServer((req, res) => {
    const current = new URL(req.url, callbackUrl);
    if (current.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    callback = current;
    // The client receives the code over its callback. It never renders the code.
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    });
    res.end(
      "<!doctype html><html><body><p>Returned to the local MCP client.</p></body></html>",
    );
  });
  await new Promise((resolve) =>
    callbackServer.listen(0, "127.0.0.1", resolve),
  );
  callbackUrl =
    "http://127.0.0.1:" + callbackServer.address().port + "/callback";
  const metadata = await request("/.well-known/oauth-protected-resource/mcp");
  assert.equal(metadata.data.resource, resource);
  const registered = await request("/oauth/register", {
    method: "POST",
    status: 201,
    body: {
      client_name: "Local MCP browser acceptance",
      redirect_uris: [callbackUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
  });
  const clientId = registered.data.client_id;
  assert.ok(!registered.data.client_secret);
  const pending = await begin(clientId, [
    ...scopes,
    "content:publish",
    "community:post",
    "community:reply",
    "community:notifications",
  ]);

  browser("open", origin + pending.path);
  browser("snapshot", "-i");
  wait(
    "!![...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Sign in' && !b.disabled)",
  );
  assert.ok(
    !evaluate(
      "/mco_|mc_refresh_|fixture:alice/.test(document.querySelector('main').innerText)",
    ),
  );
  screenshot("anonymous");
  click("Sign in");
  wait(
    "!![...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Authorize connection')",
  );
  assert.ok(
    evaluate(
      "document.body.innerText.includes(" +
        JSON.stringify(new URL(callbackUrl).origin) +
        ")",
    ),
  );
  assert.equal(
    evaluate(
      "document.querySelectorAll('main input[type=checkbox]:checked').length",
    ),
    2,
  );
  assert.equal(
    evaluate(
      "[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Authorize connection').disabled",
    ),
    true,
  );
  checks.push(
    "connection begins with sign-in and an explicit client origin; optional scopes start off",
  );

  // Privy can return to this route with its own query parameters. The opaque
  // pending request is recovered from this isolated browser session.
  browser("open", origin + "/agents/connect");
  wait(
    "!![...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Authorize connection')",
  );
  browser("find", "label", "Agent name", "fill", name);
  for (const width of [1440, 390, 320]) {
    browser("set", "viewport", String(width), "900");
    assert.ok(
      evaluate("document.documentElement.scrollWidth <= innerWidth"),
      "Consent layout width " + width,
    );
    if (width !== 320) screenshot("consent-" + width);
  }
  evaluate(
    "[...document.querySelectorAll('main input[type=checkbox]')].at(-1).click()",
  );
  click("Authorize connection");
  const code = await received(pending);
  const tokens = await exchange(clientId, pending, code);
  assert.ok(tokens.access_token.startsWith("mco_"));
  assert.ok(tokens.refresh_token.startsWith("mc_refresh_"));
  assert.deepEqual(tokens.scope.split(" "), scopes);
  const ownerAgents = await api("/me/agents");
  const agent = ownerAgents.find((item) => item.name === name);
  assert.ok(agent, "Authorized Agent was not created");
  createdAgents.push(agent.id);
  assert.deepEqual(agent.scopes, scopes);
  assert.equal(agent.publicVisible, false);
  checks.push(
    "login return survives; owner approves drafts only; client receives credentials without displaying them",
  );

  browser("set", "viewport", "390", "844");
  browser("open", origin + "/agents");
  wait("!!" + card());
  assert.ok(
    evaluate(
      card() +
        ".innerText.includes('Authorized · waiting for a verified MCP request')",
    ),
  );
  assert.ok(!evaluate(card() + ".innerText.includes('Rotate key')"));
  const client = await connect(tokens.access_token);
  await client.listTools();
  click("Refresh", "document.querySelector('#your-agents')");
  wait("!!" + card());
  assert.ok(
    evaluate(
      card() +
        ".innerText.includes('Authorized · waiting for a verified MCP request')",
    ),
  );
  const identity = await tool(client, "get_agent");
  assert.equal(identity.id, agent.id);
  assert.equal(identity.httpStatus, 200);
  const draft = await tool(client, "create_creation", {
    content: {
      type: "article",
      title: "OAuth private browser acceptance",
      description: "Local verification",
      aiDeclaration: true,
      aiTools: ["Local acceptance"],
      tagIds: [],
      articleDocument: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "This local test stays private." }],
          },
        ],
      },
    },
    idempotencyKey: crypto.randomUUID(),
  });
  assert.equal(draft.httpStatus, 201);
  assert.equal(draft.status, "draft");
  createdWorks.push(draft.workId);
  assert.equal(
    (await tool(client, "get_creation", { id: draft.workId, draft: true }))
      .workId,
    draft.workId,
  );
  await api("/works/" + draft.workId, { token: null, status: 404 });
  assert.equal(
    (
      await tool(client, "publish_creation", {
        id: draft.workId,
        revisionId: draft.revisionId,
        idempotencyKey: crypto.randomUUID(),
      })
    ).httpStatus,
    403,
  );
  assert.equal(
    (await api("/agent", { token: tokens.access_token, status: 403 })).error
      .code,
    "MCP_ONLY",
  );
  click("Refresh", "document.querySelector('#your-agents')");
  wait(
    card() +
      "?.innerText.includes('Connected · verified MCP request received')",
  );
  evaluate(card() + ".scrollIntoView({block:'center'})");
  screenshot("connected");
  checks.push(
    "tools/list does not claim connection; successful MCP identity and private draft readback do",
  );

  for (const [action, status] of [
    ["Pause", "paused"],
    ["Resume", "active"],
  ]) {
    click(action, card());
    click("Confirm", dialog);
    wait(
      card() +
        "?.querySelector('.status-chip').textContent === " +
        JSON.stringify(status),
    );
    assert.equal((await tool(client, "get_agent")).status, status);
    assert.equal(
      (await tool(client, "get_creation", { id: draft.workId, draft: true }))
        .httpStatus,
      status === "paused" ? 403 : 200,
    );
  }
  checks.push(
    "owner pause and resume immediately control an existing OAuth MCP connection",
  );

  const denied = await begin(clientId);
  browser("open", origin + denied.path);
  wait("document.body.innerText.includes('Reconnects your existing Agent')");
  assert.equal(
    evaluate("document.querySelector('main input:not([type=checkbox])').value"),
    name,
  );
  click("Switch test account");
  wait(
    "sessionStorage.getItem('musecity.fixture-user') === 'bob' && !!document.querySelector('main form') && !document.body.innerText.includes('Reconnects your existing Agent')",
  );
  assert.equal(
    evaluate("document.querySelector('main input:not([type=checkbox])').value"),
    "",
  );
  click("Switch test account");
  wait(
    "sessionStorage.getItem('musecity.fixture-user') === 'alice' && document.body.innerText.includes('Reconnects your existing Agent')",
  );
  click("Deny");
  await received(denied, true);
  assert.equal(
    (await api("/me/agents")).filter((item) => item.id === agent.id).length,
    1,
  );
  checks.push(
    "reconnect reuses the owner's Agent, account switching clears it, and denial returns safely",
  );

  browser("open", origin + "/agents");
  wait("!!" + card());
  click("Revoke", card());
  click("Confirm", dialog);
  wait(card() + "?.querySelector('.status-chip').textContent === 'revoked'");
  wait(card() + "?.innerText.includes('OAuth connection revoked')");
  await assert.rejects(() => tool(client, "get_agent"));
  await request("/oauth/token", {
    method: "POST",
    status: 400,
    form: {
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: tokens.refresh_token,
      resource,
    },
  });
  evaluate(card() + ".scrollIntoView({block:'center'})");
  screenshot("revoked");
  checks.push(
    "owner revocation removes both MCP and refresh access without exposing a new key",
  );
  assert.deepEqual(browser("errors").errors ?? [], []);
  writeFileSync(
    output + "/verification.json",
    JSON.stringify(
      {
        origin,
        evidence:
          "isolated local browser identity, local OAuth client and real local PostgreSQL; no ChatGPT/dot or production acceptance",
        checks,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: checks.length, checks }, null, 2));
} catch (error) {
  try {
    writeFileSync(
      output + "/failure.json",
      JSON.stringify(
        evaluate(
          "({path:location.pathname,user:sessionStorage.getItem('musecity.fixture-user'),alerts:[...document.querySelectorAll('[role=alert]')].map(e=>e.textContent),agents:[...document.querySelectorAll('.agent-card h3')].map(e=>e.textContent)})",
        ),
        null,
        2,
      ),
    );
  } catch {
    /* Preserve the primary failure if the browser is unavailable. */
  }
  throw error;
} finally {
  await Promise.all(connections.map((client) => client.close()));
  for (const id of createdWorks)
    await api("/works/" + id, { method: "DELETE", body: {} });
  for (const id of createdAgents) {
    const agent = await api("/me/agents/" + id);
    if (agent.status !== "revoked")
      await api("/me/agents/" + id + "/revoke", {
        method: "POST",
        body: { confirmed: true },
      });
  }
  if (callbackServer)
    await new Promise((resolve) => callbackServer.close(resolve));
  browser("close");
}
