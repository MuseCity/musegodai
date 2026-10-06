// Local fixture only: run with pnpm e2e:serve. No production writes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import pg from "pg";
import { assertLocalTarget } from "../scripts/local-target.ts";

const origin = "http://127.0.0.1:5191";
const session = "musecity-agent-hub-" + process.pid;
const output = resolve(".local/agent-hub");
mkdirSync(output, { recursive: true });
const local = JSON.parse(readFileSync(".local/database.json", "utf8"));
assertLocalTarget(local.e2eAdminUrl, "musecity_e2e", "musecity_admin");
const db = new pg.Client({ connectionString: local.e2eAdminUrl });
const checks = [],
  agents = [],
  works = [];
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
const scopes = ["content:read", "content:write"];
const name = "Hub browser " + Date.now();
function card(agentName) {
  return (
    "[...document.querySelectorAll('.agent-card')].find(c=>c.querySelector('h3').textContent===" +
    JSON.stringify(agentName) +
    ")"
  );
}
try {
  await db.connect();
  const html = await (await fetch(origin + "/agents")).text();
  for (const text of [
    "Agent Onboarding",
    "Connect from your AI client",
    "Connect with OAuth",
    "Developer setup",
  ])
    assert.ok(html.includes(text));
  assert.ok(html.includes('content="index, follow, max-image-preview:large"'));
  assert.ok(!html.includes("fixture:alice"));
  browser("open", origin + "/agents");
  browser("snapshot", "-i");
  wait(
    "!![...document.querySelectorAll('button')].find(b=>b.textContent==='Sign in to manage agents' && !b.disabled)",
  );
  assert.equal(
    evaluate(
      "document.querySelector('.header-agent-link[aria-current=page]').textContent",
    ),
    "Agent Onboarding",
  );
  assert.equal(evaluate("document.querySelectorAll('h1').length"), 1);
  click("Copy", "document.querySelector('#connect .agent-copy')");
  wait(
    "document.querySelector('#connect [role=status]').textContent.length > 0",
  );
  checks.push(
    "anonymous SSR, active navbar, public guidance and copy feedback",
  );
  for (const width of [1440, 1321, 1281, 1101, 1024, 768, 390, 320]) {
    browser("set", "viewport", String(width), "900");
    assert.ok(
      evaluate("document.documentElement.scrollWidth <= innerWidth"),
      "layout width " + width,
    );
    assert.ok(
      evaluate(
        "[...document.querySelectorAll('.primary-nav a, .header-agent-link')].every(a=>{const r=a.getBoundingClientRect();return r.x>=0 && r.right<=innerWidth;})",
      ),
      "navbar width " + width,
    );
    if ([1440, 390].includes(width))
      browser("screenshot", output + "/public-" + width + ".png");
  }
  checks.push(
    "four primary tabs and the onboarding text link visible without overflow at 320, 390, 768, 1024, 1101 and 1440 pixels",
  );
  browser("set", "viewport", "390", "844");
  click("Sign in to manage agents");
  wait(
    "!![...document.querySelectorAll('button')].find(b=>b.textContent==='Create developer invitation')",
  );
  for (const width of [1440, 1321, 1281, 1101, 768, 390, 320]) {
    browser("set", "viewport", String(width), "900");
    assert.ok(
      evaluate("document.documentElement.scrollWidth <= innerWidth"),
      "signed-in layout width " + width,
    );
  }
  browser("set", "viewport", "390", "844");
  evaluate(
    "[...document.querySelectorAll('#your-agents details')].find(d=>d.querySelector('summary')?.textContent==='Developer setup · manual credentials').open=true",
  );
  click("Create developer invitation");
  browser("snapshot", "-i");
  assert.equal(
    evaluate(
      "document.querySelectorAll('dialog input[type=checkbox]:checked').length",
    ),
    0,
  );
  assert.equal(
    evaluate(
      "[...document.querySelectorAll('dialog button')].find(b=>b.textContent==='Create invitation').disabled",
    ),
    true,
  );
  browser("find", "label", "Agent name", "fill", name);
  evaluate(
    "[...document.querySelectorAll('dialog input[type=checkbox]')].at(-1).click()",
  );
  click("Create invitation", dialog);
  wait("!!document.querySelector('dialog .secret')");
  // Secrets stay in process memory, outside reports and screenshots.
  const instruction = evaluate(
    "document.querySelector('dialog .secret').textContent",
  );
  const invitation = JSON.parse(instruction);
  const invitationToken = invitation.invitationToken;
  assert.equal(invitation.name, name);
  assert.deepEqual(invitation.requestedScopes, scopes);
  assert.ok(invitationToken.startsWith("mci_"));
  closeDialog();
  const registration = await post(
    "/agent-registrations",
    { name, requestedScopes: scopes, invitationToken },
    { token: null, status: 201 },
  );
  assert.equal(registration.status, "approved");
  assert.equal(registration.claimPath, null);
  wait(
    "document.querySelector('#your-agents').innerText.includes('Awaiting activation')",
  );
  const active = await post(
    "/agent-registrations/" + registration.registrationId + "/activate",
    undefined,
    { token: registration.registrationToken, status: 201 },
  );
  agents.push(active.agentId);
  assert.deepEqual(active.scopes, scopes);
  wait("!!" + card(name));
  checks.push(
    "draft-only invitation requires confirmation and polls registration to activation",
  );

  evaluate("document.querySelector('#developer-setup').open=true");
  const draftBody = JSON.parse(
    evaluate(
      "[...document.querySelectorAll('#developer-setup .agent-copy code')].at(-1).textContent",
    ),
  );
  const diagnostic = await api("/agent", { token: active.credential.token });
  assert.equal(diagnostic.id, active.agentId);
  const draft = await post("/works", draftBody, {
    token: active.credential.token,
    status: 201,
  });
  works.push(draft.workId);
  assert.equal(draft.status, "draft");
  assert.equal(
    (
      await api("/works/" + draft.workId + "?draft=true", {
        token: active.credential.token,
      })
    ).workId,
    draft.workId,
  );
  await api("/works/" + draft.workId, { token: null, status: 404 });
  checks.push("displayed REST draft example succeeds and stays private");

  for (const [action, state] of [
    ["Pause", "paused"],
    ["Resume", "active"],
  ]) {
    click(action, card(name));
    click("Confirm", dialog);
    wait(card(name) + "?.innerText.includes(" + JSON.stringify(state) + ")");
    await api("/works/" + draft.workId + "?draft=true", {
      token: active.credential.token,
      status: state === "paused" ? 403 : 200,
    });
  }
  click("Rotate key", card(name));
  click("Confirm", dialog);
  wait("!!document.querySelector('dialog .secret')");
  const rotated = evaluate(
    "document.querySelector('dialog .secret').textContent",
  );
  closeDialog();
  await api("/agent", { token: active.credential.token, status: 401 });
  await api("/agent", { token: rotated });
  click("View activity", card(name));
  wait(
    "!!document.querySelector('dialog')?.innerText.includes('Created a draft')",
  );
  closeDialog();
  checks.push(
    "embedded pause/resume, rotation and activity preserve existing behavior",
  );
  click("Switch test account");
  wait(
    "sessionStorage.getItem('musecity.fixture-user') === 'bob' && " +
      "!document.querySelector('#your-agents').innerText.includes('Loading agents…') && !" +
      card(name),
  );
  click("Switch test account");
  wait(
    "sessionStorage.getItem('musecity.fixture-user') === 'alice' && !!" +
      card(name),
  );
  checks.push("account switch clears the previous owner's private agents");

  const self = await post(
    "/agent-registrations",
    { name: name + " self", requestedScopes: scopes },
    { token: null, status: 201 },
  );
  browser("open", origin + self.claimPath);
  browser("snapshot", "-i");
  wait(
    "!![...document.querySelectorAll('button')].find(b=>b.textContent==='Claim and approve agent')",
  );
  assert.equal(evaluate("location.hash"), "");
  evaluate("document.querySelector('main input[type=checkbox]').click()");
  click("Claim and approve agent");
  wait("document.body.innerText.includes('Your agent is approved.')");
  click("Continue Agent Onboarding");
  wait(
    "location.pathname==='/agents' && !!document.querySelector('#your-agents')",
  );
  const selfActive = await post(
    "/agent-registrations/" + self.registrationId + "/activate",
    undefined,
    { token: self.registrationToken, status: 201 },
  );
  agents.push(selfActive.agentId);
  wait("!!" + card(name + " self"));
  checks.push(
    "self-registration, private claim, explicit approval and return to the hub",
  );

  const expired = await post(
    "/me/agent-invitations",
    { name: name + " expired", scopes, confirmed: true },
    { status: 201 },
  );
  await db.query(
    "UPDATE musecity.invitations SET expires_at=now()-interval '1 second' WHERE id=$1",
    [expired.invitationId],
  );
  click("Refresh", "document.querySelector('#your-agents')");
  wait(
    "document.querySelector('#your-agents').innerText.includes('Expired · cancel to start again')",
  );
  const row =
    "[...document.querySelectorAll('#your-agents .tab-option')].find(e=>e.textContent.includes(" +
    JSON.stringify(name + " expired") +
    "))";
  click("Cancel", row);
  wait("!" + row);
  checks.push(
    "expired invitations remain visible and can be cancelled explicitly",
  );

  for (const agentName of [name, name + " self"]) {
    click("Revoke", card(agentName));
    click("Confirm", dialog);
    wait(card(agentName) + "?.innerText.includes('revoked')");
  }
  await api("/agent", { token: rotated, status: 401 });
  checks.push("revocation from unified management invalidates the active key");
  browser("open", origin + "/agents/mcp");
  wait("document.body.innerText.includes('Connect with MCP')");
  assert.equal(
    evaluate(
      "document.querySelector('.header-agent-link[aria-current=page]').textContent",
    ),
    "Agent Onboarding",
  );
  browser("open", origin + "/me/agents");
  wait("!!" + card(name));
  assert.equal(evaluate("document.querySelectorAll('h1').length"), 1);
  checks.push(
    "existing MCP and My agents URLs work and link back to onboarding",
  );
  assert.deepEqual(browser("errors").errors ?? [], []);
  writeFileSync(
    output + "/verification.json",
    JSON.stringify(
      {
        origin,
        evidence: "local fixture identity and PostgreSQL only",
        checks,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ passed: checks.length, checks }, null, 2));
} catch (error) {
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
  throw error;
} finally {
  for (const id of works) await api("/works/" + id, { method: "DELETE" });
  for (const id of agents) {
    const agent = await api("/me/agents/" + id);
    if (agent.status !== "revoked")
      await post("/me/agents/" + id + "/revoke", { confirmed: true });
  }
  await db.end();
  browser("close");
}
