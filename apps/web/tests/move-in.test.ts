import { beforeEach, describe, expect, it } from "vitest";
import { fixture, reset, config } from "./helpers";
import { withDatabase } from "../src/server/database";
import { draftScopes } from "../src/shared/contracts";
import { nextMoveInStep } from "../src/shared/onboarding";

beforeEach(reset);
type Fixture = ReturnType<typeof fixture>;
const action = (f: Fixture, body: unknown, key?: string) =>
  f.call("/me/onboarding", { method: "PATCH", body, key });
const read = async (f: Fixture, token = "fixture:alice") =>
  (await f.call("/me/onboarding", { token })).data;
const publish = (f: Fixture, key?: string, text = "Hello, neighbors!") =>
  f.call("/me/onboarding/posts", { method: "POST", body: { text }, key });
async function join(f: Fixture) {
  const result = await f.call("/me", {
    method: "PATCH",
    body: {
      name: "Alice",
      handle: "alice",
      avatarMediaId: null,
      bio: "",
      join: true,
    },
  });
  expect(result.status).toBe(200);
  return result.data;
}
async function invite(f: Fixture) {
  const result = await f.call("/me/agent-invitations", {
    method: "POST",
    body: { name: "My Muse", scopes: draftScopes, confirmed: true },
  });
  expect(result.status).toBe(201);
  return result.data;
}
async function register(f: Fixture, invitationToken: string) {
  const result = await f.call("/agent-registrations", {
    token: null,
    method: "POST",
    body: { name: "My Muse", requestedScopes: draftScopes, invitationToken },
  });
  expect(result.status).toBe(201);
  return result.data;
}
async function activate(f: Fixture, registration: any) {
  const result = await f.call(
    "/agent-registrations/" + registration.registrationId + "/activate",
    { method: "POST", token: registration.registrationToken },
  );
  expect(result.status).toBe(201);
  await f.call("/agent", { token: result.data.credential.token });
  return result.data;
}
describe("Move in through the isolated PostgreSQL API", () => {
  it("requires explicit membership, persists only owner intent, and resumes without inventing completion", async () => {
    const f = fixture();
    const initial = await read(f);
    expect(initial).toMatchObject({
      startedAt: null,
      finishedAt: null,
      profile: { joinedAt: null },
      introduction: { status: "pending" },
      muse: { status: "pending", deferred: false },
    });
    expect(nextMoveInStep(initial)).toBe("profile");
    expect(
      (await f.call("/neighbors", { token: null })).data.items,
    ).toHaveLength(0);
    const start = await action(f, { action: "start" });
    expect(start.status).toBe(200);
    expect(start.data.startedAt).toBeTruthy();
    expect(start.data.profile.joinedAt).toBeNull();
    for (const body of [
      { action: "skip", step: "hello" },
      { action: "finish" },
    ]) {
      expect((await action(f, body)).data.error.code).toBe("MOVE_IN_REQUIRED");
    }
    expect((await publish(f)).data.error.code).toBe("MOVE_IN_REQUIRED");
    await join(f);
    expect(nextMoveInStep(await read(f))).toBe("hello");
    expect(
      (await f.call("/neighbors", { token: null })).data.items,
    ).toHaveLength(1);
    expect((await action(f, { action: "finish" })).data.error.code).toBe(
      "ONBOARDING_INCOMPLETE",
    );
    const skipped = await action(f, { action: "skip", step: "hello" });
    expect(skipped.data.introduction).toEqual({
      status: "skipped",
      post: null,
    });
    expect(nextMoveInStep(skipped.data)).toBe("muse");
    await action(f, { action: "skip", step: "muse" });
    const finished = await action(f, { action: "finish" });
    expect(finished.data.finishedAt).toBeTruthy();
    expect(nextMoveInStep(await read(f))).toBe("done");
    expect((await action(f, { action: "start" })).data.finishedAt).toBe(
      finished.data.finishedAt,
    );
    const resumed = await action(f, { action: "resume", step: "hello" });
    expect(resumed.data).toMatchObject({
      finishedAt: null,
      introduction: { status: "pending" },
      muse: { deferred: true },
    });
    const bob = await read(f, "fixture:bob");
    expect(bob).toMatchObject({
      startedAt: null,
      finishedAt: null,
      profile: { joinedAt: null },
      introduction: { status: "pending" },
    });
  });

  it("atomically publishes one introduction across concurrent tabs, lost responses, and new retry keys", async () => {
    const f = fixture();
    const owner = await join(f);
    const key = crypto.randomUUID();
    const results = await Promise.all([
      publish(f, key),
      publish(f),
      publish(f),
    ]);
    for (const result of results) expect(result.status).toBe(201);
    expect(new Set(results.map((result) => result.data.id)).size).toBe(1);
    const post = results[0]!.data;
    expect(post).toMatchObject({
      text: "Hello, neighbors!",
      kind: "update",
      agent: null,
      owner: { id: owner.id },
    });
    expect((await publish(f, key)).data).toEqual(post);
    expect(
      (await publish(f, undefined, "My retry after a lost response")).data,
    ).toEqual(post);
    expect((await publish(f, key, "Changed same key")).status).toBe(409);
    const state = await read(f);
    expect(state.introduction).toEqual({ status: "complete", post });
    expect(state.startedAt).toBeTruthy();
    const rows = await withDatabase(config.testUrl, (d) =>
      d.query("SELECT id FROM musecity.posts WHERE owner_account_id=$1", [
        owner.id,
      ]),
    );
    expect(rows).toHaveLength(1);
    // Ordinary Share still creates separate updates, with its existing contract.
    const ordinary = await f.call("/posts", {
      method: "POST",
      body: { kind: "update", text: "A later update" },
    });
    expect(ordinary.status).toBe(201);
    expect(ordinary.data.id).not.toBe(post.id);
  });

  it("rolls back the introduction and progress when the shared publication budget is exhausted", async () => {
    const f = fixture();
    const owner = await join(f);
    await withDatabase(config.testAdminUrl, (d) =>
      d.query(
        "INSERT INTO musecity.rate_limits(key,counter,expires_at) VALUES($1,20,now()+interval '2 days')",
        [
          `community:${owner.id}:publication:${new Date().toISOString().slice(0, 10)}`,
        ],
      ),
    );
    const failed = await publish(f);
    expect(failed.status).toBe(429);
    expect(failed.data.error.code).toBe("COMMUNITY_DAILY_LIMIT");
    expect(await read(f)).toMatchObject({
      startedAt: null,
      introduction: { status: "pending", post: null },
    });
    expect(
      await withDatabase(config.testUrl, (d) =>
        d.query("SELECT id FROM musecity.posts"),
      ),
    ).toHaveLength(0);
  });

  it("recognizes existing human updates, protects removed content on replays, and does not require reposting", async () => {
    const f = fixture();
    await join(f);
    const post = (
      await f.call("/posts", {
        method: "POST",
        body: { kind: "update", text: "Already here" },
      })
    ).data;
    expect(await read(f)).toMatchObject({
      startedAt: null,
      introduction: { status: "complete", post: { id: post.id } },
    });
    const startKey = crypto.randomUUID();
    await action(f, { action: "start" }, startKey);
    const publishKey = crypto.randomUUID();
    expect((await publish(f, publishKey)).data.id).toBe(post.id);
    await withDatabase(config.testAdminUrl, (d) =>
      d.query("UPDATE musecity.posts SET blocked=true WHERE id=$1", [post.id]),
    );
    expect(await read(f)).toMatchObject({
      introduction: { status: "complete", post: null },
    });
    expect(
      (await action(f, { action: "start" }, startKey)).data.introduction,
    ).toEqual({ status: "complete", post: null });
    expect((await publish(f, publishKey)).status).toBe(404);
    expect((await publish(f)).status).toBe(404);
    await withDatabase(config.testAdminUrl, (d) =>
      d.query(
        "UPDATE musecity.posts SET blocked=false,deleted=true WHERE id=$1",
        [post.id],
      ),
    );
    expect((await read(f)).introduction).toEqual({
      status: "complete",
      post: null,
    });
    await action(f, { action: "skip", step: "muse" });
    expect((await action(f, { action: "finish" })).status).toBe(200);
  });

  it("tracks invitation, registration, expiration, cancellation and real activation separately", async () => {
    const f = fixture();
    await join(f);
    await action(f, { action: "skip", step: "hello" });
    const invitation = await invite(f);
    expect((await read(f)).muse).toMatchObject({
      status: "invited",
      agent: null,
      pending: { id: invitation.invitationId, kind: "invitation" },
    });
    expect((await action(f, { action: "finish" })).status).toBe(409);
    const reg = await register(f, invitation.invitationToken);
    expect((await read(f)).muse).toMatchObject({
      status: "awaiting_activation",
      pending: { id: reg.registrationId, kind: "registration" },
    });
    await action(f, { action: "skip", step: "muse" });
    const finished = await action(f, { action: "finish" });
    expect(finished.data.muse).toMatchObject({
      status: "awaiting_activation",
      deferred: true,
      agent: null,
    });
    await withDatabase(config.testAdminUrl, (d) =>
      d.query(
        "UPDATE musecity.registrations SET expires_at=now()-interval '1 second' WHERE id=$1",
        [reg.registrationId],
      ),
    );
    expect((await read(f)).muse.status).toBe("expired");
    expect(
      (
        await f.call("/me/agent-registrations/" + reg.registrationId, {
          method: "DELETE",
        })
      ).status,
    ).toBe(200);
    expect((await read(f)).muse).toMatchObject({
      status: "pending",
      deferred: true,
    });
    const replacement = await invite(f);
    const active = await activate(
      f,
      await register(f, replacement.invitationToken),
    );
    expect(active.scopes).toEqual(draftScopes);
    expect((await read(f)).muse).toMatchObject({
      status: "activated",
      agent: { id: active.agentId },
      pending: null,
    });
    await action(f, { action: "resume", step: "muse" });
    expect((await action(f, { action: "finish" })).status).toBe(200);
    // A paused or expired credential is not a working connection.
    await f.call("/me/agents/" + active.agentId + "/pause", {
      method: "POST",
      body: { confirmed: true },
    });
    expect((await read(f)).muse.status).toBe("pending");
    await f.call("/me/agents/" + active.agentId + "/resume", {
      method: "POST",
      body: { confirmed: true },
    });
    await withDatabase(config.testAdminUrl, (d) =>
      d.query(
        "UPDATE musecity.credentials SET expires_at=now()-interval '1 second' WHERE agent_id=$1",
        [active.agentId],
      ),
    );
    expect((await read(f)).muse.status).toBe("pending");
  });

  it("expires and explicitly cancels unused invitations without creating a replacement", async () => {
    const f = fixture();
    const invitation = await invite(f);
    await withDatabase(config.testAdminUrl, (d) =>
      d.query(
        "UPDATE musecity.invitations SET expires_at=now()-interval '1 second' WHERE id=$1",
        [invitation.invitationId],
      ),
    );
    expect((await read(f)).muse).toMatchObject({
      status: "expired",
      pending: { kind: "invitation" },
    });
    expect(
      (
        await f.call("/me/agent-invitations/" + invitation.invitationId, {
          method: "DELETE",
        })
      ).status,
    ).toBe(200);
    expect((await read(f)).muse).toMatchObject({
      status: "pending",
      pending: null,
    });
  });

  it("denies Agent access and client-declared completion, without confusing Agent posts with human introductions", async () => {
    const f = fixture();
    await join(f);
    const active = await activate(
      f,
      await register(f, (await invite(f)).invitationToken),
    );
    await f.call("/me/agents/" + active.agentId, {
      method: "PATCH",
      body: { scopes: [...draftScopes, "community:post"], confirmed: true },
    });
    expect(
      (
        await f.call("/posts", {
          method: "POST",
          token: active.credential.token,
          body: { kind: "update", text: "Agent update" },
        })
      ).status,
    ).toBe(201);
    expect((await read(f)).introduction.status).toBe("pending");
    for (const token of [null, active.credential.token]) {
      for (const [path, method, body] of [
        ["/me/onboarding", "GET", undefined],
        ["/me/onboarding", "PATCH", { action: "start" }],
        ["/me/onboarding/posts", "POST", { text: "Not allowed" }],
      ] as const) {
        expect((await f.call(path, { method, body, token })).status).toBe(
          token ? 403 : 401,
        );
      }
    }
    for (const body of [
      { action: "complete", step: "muse" },
      { action: "start", accountId: "someone-else" },
      { action: "skip", step: "profile" },
      { action: "finish", joinedAt: new Date().toISOString() },
    ]) {
      expect((await action(f, body)).status).toBe(400);
    }
    expect(
      (
        await f.call("/me/onboarding/posts", {
          method: "POST",
          body: { text: "Hello", ownerAccountId: "someone-else" },
        })
      ).status,
    ).toBe(400);
    expect((await read(f)).startedAt).toBeNull();
  });
});
