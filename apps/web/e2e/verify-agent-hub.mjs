// Local fixture only. No production writes or real Privy identity.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { assertLocalTarget } from "../scripts/local-target.ts";
const origin = "http://127.0.0.1:5191";
const session = "musecity-otp-" + process.pid;
const output = resolve(".local/agent-hub");
mkdirSync(output, { recursive: true });
const local = JSON.parse(readFileSync(".local/database.json", "utf8"));
assertLocalTarget(local.e2eAdminUrl, "musecity_e2e", "musecity_admin");
const db = new pg.Client({ connectionString: local.e2eAdminUrl });
const checks = [],
  agents = [],
  works = [],
  posts = [],
  comments = [],
  connections = [];
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
    "(async()=>{const end=Date.now()+12000;while(!(" +
      condition +
      ")){if(Date.now()>end)throw Error('Browser state did not settle');await new Promise(r=>setTimeout(r,80));}return true;})()",
  );
}
function click(label, scope = "document") {
  if (label.startsWith("Generate and copy")) {
    evaluate(
      "document.querySelector('.agent-connection button.primary').scrollIntoView({block:'center'})",
    );
    browser("click", ".agent-connection button.primary");
    return;
  }
  evaluate(
    "[..." +
      scope +
      ".querySelectorAll('button,a')].find(b=>b.textContent.trim()===" +
      JSON.stringify(label) +
      ").click()",
  );
}
const dialog = "document.querySelector('dialog')";
function closeDialog() {
  evaluate(
    "document.querySelector('dialog button[aria-label=\"Close dialog\"]').click()",
  );
}
async function api(
  path,
  { method = "GET", body, token = "fixture:alice", status = 200 } = {},
) {
  const response = await fetch(origin + "/api/v1" + path, {
    method,
    headers: {
      ...(token ? { Authorization: "Bearer " + token } : {}),
      "Content-Type": "application/json",
      Connection: "close",
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.equal(response.status, status, method + " " + path);
  return response.json();
}
const post = (path, body, extra = {}) =>
  api(path, { method: "POST", body, ...extra });

const name = "OTP browser " + Date.now();
const card = (agentName) =>
  "[...document.querySelectorAll('.agent-card')].find(c=>c.querySelector('h3').textContent===" +
  JSON.stringify(agentName) +
  ")";
try {
  await db.connect();
  const html = await (await fetch(origin + "/agents")).text();
  for (const text of [
    "Connect your Agent",
    "Generate and copy a connection prompt",
    "Sign in to connect your Agent",
  ])
    assert.ok(html.includes(text));
  assert.ok(!html.includes("fixture:alice"));
  browser("open", origin + "/agents");
  browser("snapshot", "-i");
  wait(
    "!![...document.querySelectorAll('button')].find(b=>b.textContent==='Sign in to connect your Agent' && !b.disabled)",
  );
  assert.equal(evaluate("document.querySelectorAll('h1').length"), 1);
  assert.ok(
    !evaluate(
      "[...document.querySelectorAll('.primary')].some(b=>/OAuth|MCP/.test(b.textContent))",
    ),
  );
  checks.push(
    "anonymous SSR and two-step OTP guide without MCP/OAuth primary controls",
  );
  for (const width of [1440, 768, 390, 320]) {
    browser("set", "viewport", String(width), "900");
    assert.ok(
      evaluate("document.documentElement.scrollWidth <= innerWidth"),
      "public width " + width,
    );
    if ([1440, 390].includes(width))
      browser("screenshot", output + "/otp-public-" + width + ".png");
  }
  checks.push(
    "anonymous desktop/mobile layouts at 1440, 768, 390 and 320 pixels",
  );
  // Give the UI a test-owned pending record so it never cancels existing fixture records.
  const seed = await post(
    "/me/agent-connections",
    { name: name + " replacement" },
    { status: 201 },
  );
  connections.push(seed.connectionId);
  click("Sign in to connect your Agent");
  wait(
    "!!document.querySelector('.agent-connection input') || !![...document.querySelectorAll('button')].find(b=>b.textContent==='Generate and copy a new prompt' && !b.disabled)",
  );
  wait(
    "!![...document.querySelectorAll('button')].find(b=>b.textContent==='Generate and copy a new prompt' && !b.disabled)",
  );
  assert.equal(
    evaluate(
      "document.querySelectorAll('.agent-connection input[type=checkbox]').length",
    ),
    0,
  );
  click("Generate and copy a new prompt");
  wait(
    "!!document.querySelector('textarea[aria-label=\"Agent connection prompt\"]')",
  );
  let prompt = evaluate(
    "document.querySelector('textarea[aria-label=\"Agent connection prompt\"]').value",
  );
  const otp = prompt.match(/mcr_[0-9a-f]{64}/)?.[0];
  assert.ok(otp);
  assert.ok(prompt.includes("POST " + origin + "/api/v1/agent-connections"));
  const pending = (await api("/me/agent-registrations")).find(
    (r) => r.status === "approved",
  );
  connections.push(pending.id);
  assert.equal(
    (await api("/me/agent-connections/" + seed.connectionId)).status,
    "cancelled",
  );
  assert.ok(
    evaluate(
      "document.querySelector('.agent-connection').innerText.includes('Waiting for your Agent')",
    ),
  );
  assert.ok(
    !evaluate(
      "document.querySelector('.agent-connection').innerText.includes('is connected.')",
    ),
  );
  const copyButton = evaluate(
    "[...document.querySelectorAll('.agent-connection button')].find(b=>/Copied|Copy connection/.test(b.textContent))?.textContent",
  );
  assert.ok(
    copyButton?.includes("Copied"),
    "Native clipboard write must succeed after the browser click",
  );
  checks.push(
    "one-click generation/copy with optional name, no scope checkbox, exact REST prompt and pending status",
  );
  const active = await post(
    "/agent-connections",
    { otp },
    { token: null, status: 201 },
  );
  agents.push(active.agentId);
  const token = active.credential.token;
  assert.deepEqual(active.scopes, [
    "content:read",
    "content:write",
    "content:publish",
    "community:post",
    "community:reply",
  ]);
  wait(
    "document.querySelector('.agent-connection').innerText.includes('Paired')",
  );
  assert.equal(
    (await api("/me/agent-connections/" + pending.id)).status,
    "awaiting_verification",
  );
  const identity = await api("/agent", { token });
  assert.equal(identity.id, active.agentId);
  wait(
    "document.querySelector('.agent-connection').innerText.includes('is connected.')",
  );
  wait(card(identity.name) + "?.innerText.includes('Connected')");
  assert.ok(
    !evaluate(
      "document.querySelector('textarea[aria-label=\"Agent connection prompt\"]')",
    ),
  );
  assert.equal(
    evaluate(
      "document.querySelectorAll('.agent-connection [role=alert]').length",
    ),
    0,
  );
  checks.push(
    "atomic redemption, awaiting-verification state and automatic Connected only after authenticated Agent use",
  );
  for (const width of [1440, 390, 320]) {
    browser("set", "viewport", String(width), "900");
    assert.ok(
      evaluate("document.documentElement.scrollWidth <= innerWidth"),
      "connected width " + width,
    );
    if ([1440, 390].includes(width))
      browser("screenshot", output + "/otp-connected-" + width + ".png");
  }
  const work = await post(
    "/works",
    {
      type: "article",
      title: name,
      description: "OTP acceptance",
      aiDeclaration: true,
      aiTools: ["Local fixture"],
      articleDocument: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Connected using one prompt." }],
          },
        ],
      },
    },
    { token, status: 201 },
  );
  works.push(work.workId);
  const published = await post(
    "/works/" + work.workId + "/publish",
    { revisionId: work.revisionId },
    { token },
  );
  assert.equal(published.status, "published");
  const update = await post(
    "/posts",
    { kind: "update", text: name },
    { token, status: 201 },
  );
  posts.push(update.id);
  const reply = await post(
    "/posts/" + update.id + "/comments",
    { text: "OTP reply" },
    { token, status: 201 },
  );
  comments.push(reply.id);
  checks.push(
    "creation publication, community post and reply succeed directly with generated permissions",
  );
  browser("open", origin + "/move-in");
  wait(
    "document.body.innerText.includes('Your Muse') || document.body.innerText.includes('Make yourself at home')",
  );
  assert.ok(
    !evaluate(
      "document.body.innerText.includes('Connect your client with OAuth')",
    ),
  );
  checks.push(
    "Move-in retains the owner guide and has no OAuth/manual invitation onboarding",
  );
  browser("open", origin + "/agents");
  wait("!!" + card(identity.name));
  click("Pause", card(identity.name));
  click("Confirm", dialog);
  wait(card(identity.name) + "?.innerText.includes('paused')");
  await post(
    "/posts",
    { kind: "update", text: "Paused" },
    { token, status: 403 },
  );
  click("Resume", card(identity.name));
  click("Confirm", dialog);
  wait(card(identity.name) + "?.innerText.includes('active')");
  checks.push(
    "owner pause/resume controls OTP Agent content actions through the UI",
  );
  const path = "/me/agents/" + active.agentId;
  const rotated = await post(path + "/credentials/rotate", { confirmed: true });
  await api("/agent", { token, status: 401 });
  assert.equal(
    (await api("/me/agent-connections/" + pending.id)).status,
    "awaiting_verification",
  );
  await api("/agent", { token: rotated.credential.token });
  checks.push(
    "credential replacement invalidates the old key and requires verification again",
  );
  const lost = await post(
    "/me/agent-connections",
    { name: name + " lost" },
    { status: 201 },
  );
  connections.push(lost.connectionId);
  browser("open", origin + "/agents");
  wait(
    "document.querySelector('.agent-connection').innerText.includes('Generate a new prompt if you no longer have it')",
  );
  assert.ok(
    !evaluate(
      "document.querySelector('textarea[aria-label=\"Agent connection prompt\"]')",
    ),
  );
  await db.query(
    "UPDATE musecity.registrations SET expires_at=now()-interval '1 second' WHERE id=$1",
    [lost.connectionId],
  );
  click("Refresh connection", "document.querySelector('.agent-connection')");
  wait(
    "document.querySelector('.agent-connection').innerText.includes('has expired')",
  );
  click("Generate and copy a new prompt");
  wait(
    "!!document.querySelector('textarea[aria-label=\"Agent connection prompt\"]')",
  );
  const replacement = (await api("/me/agent-registrations")).find(
    (r) => r.status === "approved",
  );
  connections.push(replacement.id);
  wait(
    "[...document.querySelectorAll('.tab-option')].some(row=>row.textContent.includes(" +
      JSON.stringify(name + " lost") +
      "))",
  );
  assert.equal(
    (await api("/me/agent-connections/" + lost.connectionId)).status,
    "cancelled",
  );
  checks.push(
    "refresh never recovers the secret; expired code replacement cancels its own pending record",
  );
  evaluate(
    "sessionStorage.setItem('musecity.fixture-user','bob'); location.reload()",
  );
  wait(
    "!document.querySelector('textarea[aria-label=\"Agent connection prompt\"]') && !document.body.innerText.includes('" +
      name +
      "')",
  );
  await api("/me/agent-connections/" + replacement.id, {
    token: "fixture:bob",
    status: 404,
  });
  checks.push(
    "account switching clears connection prompts and isolates status and Agent lists",
  );
  evaluate(
    "sessionStorage.setItem('musecity.fixture-user','alice'); location.reload()",
  );
  wait("!!" + card(identity.name));
  click("Revoke", card(identity.name));
  click("Confirm", dialog);
  wait(card(identity.name) + "?.innerText.includes('revoked')");
  await api("/agent", { token: rotated.credential.token, status: 401 });
  browser("open", origin + "/me/agents");
  wait("!!document.querySelector('.agent-connection')");
  browser("open", origin + "/agents/mcp");
  wait("document.body.innerText.includes('Existing MCP connections')");
  checks.push(
    "revocation blocks access; My agents OTP entry and secondary existing-MCP guide remain available",
  );
  assert.deepEqual(browser("errors").errors ?? [], []);
  writeFileSync(
    output + "/verification.json",
    JSON.stringify(
      {
        origin,
        evidence:
          "local fixture identity and PostgreSQL only; no external Agent or real Privy login",
        checks,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: checks.length, checks }, null, 2));
} catch (error) {
  browser("screenshot", output + "/otp-failure.png");
  writeFileSync(
    output + "/failure.json",
    JSON.stringify(
      evaluate(
        "({path:location.pathname,alerts:[...document.querySelectorAll('[role=alert]')].map(e=>e.textContent)})",
      ),
      null,
      2,
    ),
  );
  throw error;
} finally {
  for (const id of comments) await api("/comments/" + id, { method: "DELETE" });
  for (const id of posts) {
    const row = await api("/posts/" + id);
    await api("/posts/" + id, {
      method: "DELETE",
      body: { revision: row.revision },
    });
  }
  for (const id of works) await api("/works/" + id, { method: "DELETE" });
  for (const id of agents) {
    const agent = await api("/me/agents/" + id);
    if (agent.status !== "revoked")
      await post("/me/agents/" + id + "/revoke", { confirmed: true });
  }
  for (const row of await api("/me/agent-registrations")) {
    if (
      row.status === "approved" &&
      row.name.startsWith(name) &&
      !connections.includes(row.id)
    )
      connections.push(row.id);
  }
  for (const id of connections) {
    const row = await api("/me/agent-connections/" + id);
    if (!row.agentId && row.status !== "cancelled")
      await api("/me/agent-registrations/" + id, { method: "DELETE" });
  }
  await db.end();
  browser("close");
}
