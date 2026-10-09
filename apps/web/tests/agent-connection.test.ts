import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { connectionScopes } from "../src/shared/contracts";
import { agentConnectionPrompt } from "../src/shared/agent-connection";
import { digest } from "../src/server/crypto";
import { withDatabase } from "../src/server/database";
import { openapi, skill } from "../src/server/discovery";
import { article, config, fixture, reset } from "./helpers";

beforeEach(reset);
const generate = (f: ReturnType<typeof fixture>, name = "OTP assistant") =>
  f.call("/me/agent-connections", { method: "POST", body: { name } });
const redeem = (f: ReturnType<typeof fixture>, otp: string) =>
  f.call("/agent-connections", { token: null, method: "POST", body: { otp } });
const state = (
  f: ReturnType<typeof fixture>,
  id: string,
  token = "fixture:alice",
) => f.call("/me/agent-connections/" + id, { token });
describe("one-time Agent connection with real isolated PostgreSQL", () => {
  it("binds the owner and grants publication/posts/replies without additional approvals; verifies actual use", async () => {
    const f = fixture();
    const owner = await f.call("/me");
    const created = await generate(f);
    expect(created.status).toBe(201);
    expect(created.data.otp).toMatch(/^mcr_[0-9a-f]{64}$/);
    expect(
      new Date(created.data.expiresAt).getTime() - Date.now(),
    ).toBeGreaterThan(590000);
    expect(
      new Date(created.data.expiresAt).getTime() - Date.now(),
    ).toBeLessThanOrEqual(600000);
    expect((await state(f, created.data.connectionId)).data.status).toBe(
      "waiting",
    );
    const active = await redeem(f, created.data.otp);
    expect(active.status).toBe(201);
    expect(active.data.scopes).toEqual(connectionScopes);
    expect(active.data.ownerAccountId).toBe(owner.data.id);
    expect((await state(f, created.data.connectionId)).data.status).toBe(
      "awaiting_verification",
    );
    expect((await f.call("/me/onboarding")).data.muse.status).not.toBe(
      "activated",
    );
    const token = active.data.credential.token;
    const identity = await f.call("/agent", { token });
    expect(identity.status).toBe(200);
    expect(identity.data).toMatchObject({
      id: active.data.agentId,
      status: "active",
      owner: { id: owner.data.id },
    });
    expect((await state(f, created.data.connectionId)).data.status).toBe(
      "connected",
    );
    expect((await f.call("/me/onboarding")).data.muse.status).toBe("activated");
    const draft = await f.call("/works", {
      token,
      method: "POST",
      body: article,
    });
    expect(draft.status).toBe(201);
    const published = await f.call("/works/" + draft.data.workId + "/publish", {
      token,
      method: "POST",
      body: { revisionId: draft.data.revisionId },
    });
    expect(published.status).toBe(200);
    expect(published.data).toMatchObject({
      status: "published",
      owner: { id: owner.data.id },
      submittedBy: { id: active.data.agentId },
    });
    const post = await f.call("/posts", {
      token,
      method: "POST",
      body: { kind: "update", text: "Connected with one prompt" },
    });
    expect(post.status).toBe(201);
    expect(
      (
        await f.call("/posts/" + post.data.id + "/comments", {
          token,
          method: "POST",
          body: { text: "Reply without another permission prompt" },
        })
      ).status,
    ).toBe(201);
    for (const path of [
      "/me",
      "/me/agents",
      "/me/membership",
      "/agent/notifications",
    ])
      expect((await f.call(path, { token })).status).toBe(403);
    expect((await generate(f)).status).toBe(201);
  });
  it("redeems only once under concurrent requests and never stores or reveals plaintext secrets", async () => {
    const f = fixture(),
      created = await generate(f);
    const results = await Promise.all([
      redeem(f, created.data.otp),
      redeem(f, created.data.otp),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const active = results.find((r) => r.status === 201)!;
    const record = await withDatabase(config.testAdminUrl, (d) =>
      d.one<any>(
        "SELECT token_hash,status,agent_id FROM musecity.registrations WHERE id=$1",
        [created.data.connectionId],
      ),
    );
    expect(record).toMatchObject({
      token_hash: await digest(created.data.otp),
      status: "activated",
      agent_id: active.data.agentId,
    });
    const status = await state(f, created.data.connectionId);
    const records = await f.call("/me/agent-registrations");
    for (const response of [status, records, await f.call("/me/agents")]) {
      expect(JSON.stringify(response.data)).not.toContain(created.data.otp);
      expect(JSON.stringify(response.data)).not.toContain(
        active.data.credential.token,
      );
    }
    const cached = await withDatabase(config.testAdminUrl, (d) =>
      d.query("SELECT response FROM musecity.idempotency"),
    );
    expect(JSON.stringify(cached)).not.toContain(created.data.otp);
    expect(JSON.stringify(cached)).not.toContain(active.data.credential.token);
  });
  it("rejects expired and cancelled codes, owner impersonation, scope injection and Agent-managed connections", async () => {
    const f = fixture(),
      created = await generate(f);
    expect(
      (await state(f, created.data.connectionId, "fixture:bob")).status,
    ).toBe(404);
    expect(
      (
        await f.call("/me/agent-connections", {
          method: "POST",
          token: null,
          body: {},
        })
      ).status,
    ).toBe(401);
    for (const body of [
      { ownerAccountId: "other" },
      { scopes: ["community:notifications"] },
    ])
      expect(
        (await f.call("/me/agent-connections", { method: "POST", body }))
          .status,
      ).toBe(400);
    expect(
      (
        await f.call("/agent-connections", {
          token: null,
          method: "POST",
          body: { otp: created.data.otp, ownerAccountId: "other" },
        })
      ).status,
    ).toBe(400);
    await withDatabase(config.testAdminUrl, (d) =>
      d.query(
        "UPDATE musecity.registrations SET expires_at=now()-interval '1 second' WHERE id=$1",
        [created.data.connectionId],
      ),
    );
    expect((await redeem(f, created.data.otp)).status).toBe(410);
    expect((await state(f, created.data.connectionId)).data.status).toBe(
      "expired",
    );
    const next = await generate(f);
    await f.call("/me/agent-registrations/" + next.data.connectionId, {
      method: "DELETE",
    });
    expect((await redeem(f, next.data.otp)).status).toBe(403);
    expect((await state(f, next.data.connectionId)).data.status).toBe(
      "cancelled",
    );
    const active = await redeem(f, (await generate(f)).data.otp);
    expect(
      (
        await f.call("/me/agent-connections", {
          token: active.data.credential.token,
          method: "POST",
          body: {},
        })
      ).status,
    ).toBe(403);
  });
  it("enforces pause, revocation, credential replacement and current owner restrictions", async () => {
    const f = fixture(),
      created = await generate(f),
      active = await redeem(f, created.data.otp);
    let token = active.data.credential.token;
    const path = "/me/agents/" + active.data.agentId;
    await f.call("/agent", { token });
    await f.call(path + "/pause", {
      method: "POST",
      body: { confirmed: true },
    });
    expect((await state(f, created.data.connectionId)).data.status).toBe(
      "paused",
    );
    expect(
      (
        await f.call("/posts", {
          token,
          method: "POST",
          body: { kind: "update", text: "Paused" },
        })
      ).status,
    ).toBe(403);
    expect((await f.call("/agent", { token })).data.status).toBe("paused");
    await f.call(path + "/resume", {
      method: "POST",
      body: { confirmed: true },
    });
    const replacement = await f.call(path + "/credentials/rotate", {
      method: "POST",
      body: { confirmed: true },
    });
    expect((await f.call("/agent", { token })).status).toBe(401);
    expect((await state(f, created.data.connectionId)).data.status).toBe(
      "awaiting_verification",
    );
    token = replacement.data.credential.token;
    await f.call("/agent", { token });
    expect((await state(f, created.data.connectionId)).data.status).toBe(
      "connected",
    );
    await withDatabase(config.testAdminUrl, (d) =>
      d.query("UPDATE musecity.accounts SET status='restricted' WHERE id=$1", [
        active.data.ownerAccountId,
      ]),
    );
    expect(
      (
        await f.call("/posts", {
          token,
          method: "POST",
          body: { kind: "update", text: "Restricted" },
        })
      ).status,
    ).toBe(403);
    await withDatabase(config.testAdminUrl, (d) =>
      d.query("UPDATE musecity.accounts SET status='active' WHERE id=$1", [
        active.data.ownerAccountId,
      ]),
    );
    await f.call(path + "/revoke", {
      method: "POST",
      body: { confirmed: true },
    });
    expect((await state(f, created.data.connectionId)).data.status).toBe(
      "revoked",
    );
    expect((await f.call("/agent", { token })).status).toBe(401);
  });
  it("does not consume a code when owner restriction or the Agent limit aborts activation", async () => {
    const f = fixture(),
      created = await generate(f),
      owner = await f.call("/me");
    await withDatabase(config.testAdminUrl, async (d) => {
      await d.query(
        "UPDATE musecity.accounts SET status='restricted' WHERE id=$1",
        [owner.data.id],
      );
    });
    expect((await redeem(f, created.data.otp)).status).toBe(403);
    await withDatabase(config.testAdminUrl, async (d) => {
      await d.query(
        "UPDATE musecity.accounts SET status='active' WHERE id=$1",
        [owner.data.id],
      );
      for (let i = 0; i < 20; i++)
        await d.query(
          "INSERT INTO musecity.agents(id,owner_account_id,name,scopes) VALUES($1,$2,'Existing',$3)",
          ["limit-" + i, owner.data.id, JSON.stringify(connectionScopes)],
        );
    });
    expect((await redeem(f, created.data.otp)).status).toBe(409);
    expect((await generate(f)).status).toBe(409);
    expect((await state(f, created.data.connectionId)).data.status).toBe(
      "waiting",
    );
    await withDatabase(config.testAdminUrl, (d) =>
      d.query("DELETE FROM musecity.agents WHERE id='limit-0'"),
    );
    expect((await redeem(f, created.data.otp)).status).toBe(201);
  });
  it("counts unsuccessful guesses towards the redemption rate limit", async () => {
    const f = fixture(),
      otp = "mcr_" + "0".repeat(64);
    for (let i = 0; i < 30; i++)
      expect((await redeem(f, otp)).status).toBe(401);
    const blocked = await redeem(f, otp);
    expect(blocked.status).toBe(429);
    expect(blocked.response.headers.get("Retry-After")).toBeTruthy();
  });
  it("documents the actual OTP request/response contracts and directs the copied prompt to REST", async () => {
    const f = fixture(),
      created = await generate(f),
      active = await redeem(f, created.data.otp),
      doc = openapi("http://localhost");
    for (const [path, method, status, data] of [
      ["/me/agent-connections", "post", 201, created.data],
      ["/agent-connections", "post", 201, active.data],
      [
        "/me/agent-connections/{id}",
        "get",
        200,
        (await state(f, created.data.connectionId)).data,
      ],
    ] as const) {
      const schema = (doc.paths[path] as any)[method].responses[status].content[
        "application/json"
      ].schema;
      const expanded = JSON.parse(
        JSON.stringify({ ...schema, $defs: doc.components.schemas }).replaceAll(
          "#/components/schemas/",
          "#/$defs/",
        ),
      );
      expect(z.fromJSONSchema(expanded).safeParse(data).success).toBe(true);
    }
    const prompt = agentConnectionPrompt("http://localhost", created.data.otp);
    expect(prompt).toContain("POST http://localhost/api/v1/agent-connections");
    expect(prompt).toContain("GET http://localhost/api/v1/agent");
    expect(prompt).not.toContain(active.data.credential.token);
    expect(skill("http://localhost")).toContain(
      "No further permission approval is needed",
    );
  });
});
