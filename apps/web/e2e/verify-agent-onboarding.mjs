// Explicit live acceptance helper. Human authorization stays in the real browser.
// No Privy tokens, database access, fixture identities, or automatic publication.
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  chmodSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { z } from "zod";

const [command, lane = "self", input] = process.argv.slice(2);
const configuredOrigin = process.env.MUSECITY_ONBOARDING_ORIGIN;
assert.ok(
  configuredOrigin,
  "Set MUSECITY_ONBOARDING_ORIGIN explicitly before running acceptance.",
);
const targetOrigin = new URL(configuredOrigin);
assert.ok(
  targetOrigin.protocol === "https:" ||
    (targetOrigin.protocol === "http:" &&
      targetOrigin.hostname === "127.0.0.1"),
  "Use HTTPS or the explicit local fixture origin.",
);
assert.ok(
  !targetOrigin.username &&
    !targetOrigin.password &&
    !targetOrigin.search &&
    !targetOrigin.hash &&
    targetOrigin.pathname === "/",
  "Expected a bare origin.",
);
const origin = targetOrigin.origin;
const run =
  process.env.MUSECITY_ONBOARDING_RUN ??
  new Date().toISOString().slice(0, 10).replaceAll("-", "");
assert.match(run, /^\d{8}(?:-[a-z0-9]+)?$/);
assert.ok(["self", "invited"].includes(lane), "Use self or invited");
const root = resolve(".local", `agent-onboarding-${run}`);
const evidence = resolve("test-results", `agent-onboarding-${run}`);
mkdirSync(root, { recursive: true, mode: 0o700 });
mkdirSync(evidence, { recursive: true });
let contract;
if (existsSync(`${evidence}/openapi.json`))
  contract = JSON.parse(readFileSync(`${evidence}/openapi.json`, "utf8"));
const file = `${root}/${lane}.json`;
let state;
try {
  state = JSON.parse(readFileSync(file, "utf8"));
} catch {
  state = {};
}
const scopes = ["content:read", "content:write"];
function save() {
  writeFileSync(file, JSON.stringify(state, null, 2), { mode: 0o600 });
  chmodSync(file, 0o600);
}
function record(label, details) {
  const entry = { at: new Date().toISOString(), lane, label, ...details };
  appendFileSync(`${evidence}/events.jsonl`, JSON.stringify(entry) + "\n");
  console.log(JSON.stringify(entry));
}
async function request(
  label,
  path,
  { method = "GET", token, body, key, expected = 200 } = {},
) {
  const response = await fetch(origin + path, {
    method,
    redirect: "manual",
    signal: AbortSignal.timeout(30000),
    headers: {
      "User-Agent": "musecity-Onboarding-Acceptance/1.0",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(key ? { "Idempotency-Key": key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const data = response.headers
    .get("content-type")
    ?.includes("application/json")
    ? JSON.parse(text)
    : text;
  if (path === "/openapi.json") contract = data;
  const contractPath = path
    .replace(/^\/api\/v1/, "")
    .replace(/\/agent-registrations\/reg_[^/]+/, "/agent-registrations/{id}");
  const schema =
    contract?.paths?.[contractPath]?.[method.toLowerCase()]?.responses?.[
      response.status
    ]?.content?.["application/json"]?.schema;
  let schemaPass;
  if (schema) {
    const validator = z.fromJSONSchema(
      JSON.parse(
        JSON.stringify({
          ...schema,
          $defs: contract.components.schemas,
        }).replaceAll("#/components/schemas/", "#/$defs/"),
      ),
    );
    schemaPass = validator.safeParse(data).success;
  }
  record(label, {
    method,
    path,
    status: response.status,
    expected,
    pass: response.status === expected,
    ...(schemaPass === undefined ? {} : { schemaPass }),
    code: data?.error?.code,
    requestId: data?.requestId,
    cache: response.headers.get("cache-control"),
  });
  assert.equal(
    response.status,
    expected,
    `${label}: ${data?.error?.code ?? "unexpected HTTP status"}`,
  );
  assert.notEqual(
    schemaPass,
    false,
    `${label}: response violates live OpenAPI`,
  );
  return data;
}
const api = (label, path, options) => request(label, "/api/v1" + path, options);
async function poll() {
  const delay = Math.max(0, (state.lastPoll ?? 0) + 5000 - Date.now());
  if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
  const data = await api(
    "registration status",
    `/agent-registrations/${state.registrationId}`,
    { token: state.registrationToken },
  );
  state.lastPoll = Date.now();
  state.status = data.status;
  save();
  record("registration state", {
    status: data.status,
    approvedScopes: data.approvedScopes,
    agentId: data.agentId,
  });
  return data;
}
if (command === "baseline") {
  const skill = await request("machine guide", "/skill.md");
  const schema = await request("OpenAPI", "/openapi.json");
  writeFileSync(`${evidence}/skill.md`, skill);
  writeFileSync(`${evidence}/openapi.json`, JSON.stringify(schema, null, 2));
  assert.equal(schema.servers[0].url, origin + "/api/v1");
  assert.ok(skill.includes(origin + "/api/v1"));
  const endpoints = [
    "/agent-registrations",
    "/agent-registrations/{id}",
    "/agent-registrations/{id}/activate",
    "/agent-registrations/claim-preview",
    "/agent-registrations/{id}/claim",
    "/me/agent-invitations",
    "/me/agents",
    "/agent",
  ];
  for (const path of endpoints)
    assert.ok(schema.paths[path], `Missing ${path}`);
  record("onboarding contract discovery", {
    version: schema.info.version,
    paths: endpoints,
    skillSha256: createHash("sha256").update(skill).digest("hex"),
  });
  for (const path of ["/me/agents", "/agents/claim"])
    await request("owner page", path);
  for (const path of ["/me/agents", "/me/agent-invitations", "/agent"])
    await api("anonymous denied", path, { expected: 401 });
  await api("reject ownership injection", "/agent-registrations", {
    method: "POST",
    body: { name: "QA invalid input", ownerAccountId: "not-a-real-owner" },
    expected: 400,
  });
  await api("reject malformed scope combination", "/agent-registrations", {
    method: "POST",
    body: { name: "QA invalid input", requestedScopes: ["content:read"] },
    expected: 400,
  });
} else if (command === "register") {
  assert.ok(
    !state.registrationId,
    "Refusing to create a duplicate registration",
  );
  const invitationText = input
    ? readFileSync(resolve(input), "utf8").trim()
    : "";
  const invitation = invitationText.startsWith("{")
    ? JSON.parse(invitationText)
    : null;
  const invitationToken =
    invitation?.invitationToken ??
    invitationText.match(/mci_[A-Za-z0-9_-]+/)?.[0];
  if (lane === "invited")
    assert.ok(invitationToken, "Invitation file required");
  const name = invitation?.name ?? `Onboarding QA ${lane} ${run}`;
  if (invitation?.requestedScopes)
    assert.deepEqual(invitation.requestedScopes, scopes);
  if (invitationToken) {
    await api("invitation rejects scope escalation", "/agent-registrations", {
      method: "POST",
      body: {
        name,
        invitationToken,
        requestedScopes: [...scopes, "content:publish"],
      },
      expected: 422,
    });
  }
  const data = await api("register", "/agent-registrations", {
    method: "POST",
    body: {
      name,
      requestedScopes: scopes,
      ...(invitationToken ? { invitationToken } : {}),
    },
    expected: 201,
  });
  state = { ...data, name, invitationToken };
  save();
  assert.ok(data.registrationToken.startsWith("mcr_"));
  assert.equal(data.status, invitationToken ? "approved" : "pending_claim");
  record("registration created", {
    registrationId: data.registrationId,
    status: data.status,
    hasClaimPath: Boolean(data.claimPath),
    expiresAt: data.expiresAt,
    pollAfterSeconds: data.pollAfterSeconds,
  });
  if (invitationToken) {
    assert.equal(data.claimPath, null);
    await api("invitation cannot be reused", "/agent-registrations", {
      method: "POST",
      body: { name, requestedScopes: scopes, invitationToken },
      expected: 409,
    });
  } else {
    state.claimToken = new URL(origin + data.claimPath).hash.slice(7);
    save();
    const preview = await api(
      "claim preview",
      "/agent-registrations/claim-preview",
      { method: "POST", body: { claimToken: state.claimToken } },
    );
    assert.equal(preview.registrationId, data.registrationId);
    assert.deepEqual(preview.requestedScopes, scopes);
    await api(
      "unclaimed activation denied",
      `/agent-registrations/${data.registrationId}/activate`,
      { method: "POST", token: data.registrationToken, expected: 403 },
    );
    await api(
      "unauthenticated claim denied",
      `/agent-registrations/${data.registrationId}/claim`,
      {
        method: "POST",
        body: {
          claimToken: state.claimToken,
          approvedScopes: scopes,
          confirmed: true,
        },
        expected: 401,
      },
    );
  }
  await api("registration cannot access active agent API", "/agent", {
    token: data.registrationToken,
    expected: 403,
  });
  await poll();
} else if (command === "claim-url") {
  assert.ok(state.claimPath);
  console.log(origin + state.claimPath);
} else if (command === "poll") {
  await poll();
} else if (command === "registration-boundary") {
  await api("registration cannot access active agent API", "/agent", {
    token: state.registrationToken,
    expected: 403,
  });
} else if (command === "activate") {
  const current = await poll();
  assert.equal(current.status, "approved");
  const data = await api(
    "activate",
    `/agent-registrations/${state.registrationId}/activate`,
    { method: "POST", token: state.registrationToken, expected: 201 },
  );
  state.agentId = data.agentId;
  state.credential = data.credential;
  state.ownerAccountId = data.ownerAccountId;
  save();
  assert.deepEqual(data.scopes, scopes);
  assert.ok(data.credential.token.startsWith("mca_"));
  record("activated", {
    agentId: data.agentId,
    scopes: data.scopes,
    credentialExpiresAt: data.credential.expiresAt,
  });
  await api(
    "activation secret is one-time",
    `/agent-registrations/${state.registrationId}/activate`,
    { method: "POST", token: state.registrationToken, expected: 409 },
  );
  if (state.claimToken)
    await api(
      "used claim link rejected",
      "/agent-registrations/claim-preview",
      { method: "POST", body: { claimToken: state.claimToken }, expected: 409 },
    );
} else if (command === "exercise") {
  const token = state.credential.token;
  const identity = await api("active identity", "/agent", { token });
  record("agent diagnostics shape", { keys: Object.keys(identity) });
  await api("owner management denied", "/me/agents", { token, expected: 403 });
  await api("owner-wide private content denied", "/me/content", {
    token,
    expected: 403,
  });
  await api("own content list", "/works?mine=true", { token });
  assert.ok(!state.workId, "Refusing to create another draft");
  const body = {
    type: "article",
    title: `${state.name} private draft`,
    description: "Temporary private onboarding acceptance artifact.",
    aiDeclaration: true,
    aiTools: ["Scripted acceptance client"],
    tagIds: [],
    articleDocument: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Private test draft. Do not publish. Remove after onboarding verification.",
            },
          ],
        },
      ],
    },
  };
  state.draftKey = "onboarding-" + randomUUID();
  save();
  const work = await api("first private draft", "/works", {
    method: "POST",
    token,
    body,
    key: state.draftKey,
    expected: 201,
  });
  state.workId = work.workId;
  state.revisionId = work.revisionId;
  save();
  assert.equal(work.status, "draft");
  const retry = await api("idempotent first-call retry", "/works", {
    method: "POST",
    token,
    body,
    key: state.draftKey,
    expected: 201,
  });
  assert.equal(retry.workId, state.workId);
  await api("own private draft read", `/works/${work.workId}?draft=true`, {
    token,
  });
  await api("private draft hidden publicly", `/works/${work.workId}`, {
    expected: 404,
  });
  await api("draft-only publishing denied", `/works/${work.workId}/publish`, {
    method: "POST",
    token,
    body: { revisionId: work.revisionId },
    key: "onboarding-" + randomUUID(),
    expected: 403,
  });
  await api("unapproved community posting denied", "/posts", {
    method: "POST",
    token,
    body: {
      kind: "update",
      text: "This request must be rejected by scope checks.",
      mediaIds: [],
    },
    key: "onboarding-" + randomUUID(),
    expected: 403,
  });
  record("private draft verified", {
    workId: state.workId,
    agentId: state.agentId,
  });
} else if (
  command === "paused" ||
  command === "resumed" ||
  command === "revoked"
) {
  const token = state.credential.token;
  if (command === "revoked") {
    await api("revoked credential denied", "/agent", { token, expected: 401 });
    await api(
      "revoked draft access denied",
      `/works/${state.workId}?draft=true`,
      { token, expected: 401 },
    );
    state.revocationVerifiedAt = new Date().toISOString();
    save();
  } else {
    await api("diagnostics available", "/agent", { token });
    await api(`${command} private reads`, `/works/${state.workId}?draft=true`, {
      token,
      expected: command === "paused" ? 403 : 200,
    });
  }
} else if (command === "peer-boundary") {
  const peer = JSON.parse(
    readFileSync(
      `${root}/${lane === "self" ? "invited" : "self"}.json`,
      "utf8",
    ),
  );
  await api("peer private draft denied", `/works/${peer.workId}?draft=true`, {
    token: state.credential.token,
    expected: 404,
  });
} else if (command === "deleted") {
  await api(
    "owner-deleted test draft denied",
    `/works/${state.workId}?draft=true`,
    { token: state.credential.token, expected: 404 },
  );
  const list = await api(
    "test draft removed from private list",
    "/works?mine=true",
    { token: state.credential.token },
  );
  assert.ok(!list.items.some((work) => work.workId === state.workId));
  state.deletionVerifiedAt = new Date().toISOString();
  save();
} else if (command === "cleanup-check") {
  await api("test draft remains nonpublic", `/works/${state.workId}`, {
    expected: 404,
  });
  assert.ok(state.revocationVerifiedAt, "Revocation must be verified first");
  assert.ok(state.deletionVerifiedAt, "Owner deletion must be verified first");
  delete state.registrationToken;
  delete state.claimPath;
  delete state.claimToken;
  delete state.invitationToken;
  if (state.credential) delete state.credential.token;
  save();
  if (lane === "invited" && input) {
    const invitationFile = resolve(input);
    assert.equal(
      dirname(invitationFile),
      root,
      "Only remove this run's invitation file",
    );
    if (existsSync(invitationFile)) unlinkSync(invitationFile);
  }
  record("test credential cleanup", { agentId: state.agentId, revoked: true });
} else {
  throw new Error(
    "Run from apps/web. Commands: baseline, register [self|invited] [invitation-file], claim-url (prints a private secret), poll, registration-boundary, activate, exercise, paused, resumed, peer-boundary, deleted, revoked, cleanup-check [self|invited] [invitation-file]. Human approval, invitation creation, draft deletion and revocation use the real browser. Use MUSECITY_ONBOARDING_RUN=YYYYMMDD-suffix for a separate run. All writes target production; authorize a bounded test before running.",
  );
}
