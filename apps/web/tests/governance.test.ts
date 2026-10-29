import { beforeEach, describe, expect, it, vi } from "vitest";
import { fixture, reset, config } from "./helpers";
import { withDatabase } from "../src/server/database";
import { ApiError } from "../src/server/errors";
import { governanceRules } from "../src/shared/governance";
import { scopes } from "../src/shared/contracts";

beforeEach(reset);
const threshold = BigInt(governanceRules.threshold);
const address = "0x1111111111111111111111111111111111111111";
const sql = (query: string, values: unknown[] = []) =>
  withDatabase(config.testAdminUrl, (db) => db.query(query, values));
function setup() {
  const f = fixture();
  const balances = new Map([["did:privy:alice", threshold]]);
  const addresses = new Map([["did:privy:alice", address]]);
  f.services.verify = async (token) => {
    if (!/^fixture:(alice|bob|carol|dave|eve|frank)$/.test(token))
      throw new ApiError(401, "INVALID_CREDENTIAL", "Invalid fixture");
    return "did:privy:" + token.slice(8);
  };
  const balance = vi.fn(
    async (wallet: string, rules: typeof governanceRules) => {
      expect(rules.chainId).toBe(4663);
      expect(rules.tokenAddress).toBe(governanceRules.tokenAddress);
      const owner = [...addresses].find(([, value]) => value === wallet)?.[0];
      return balances.get(owner ?? "") ?? 0n;
    },
  );
  f.services.wallets = {
    linkedAddresses: async (user) =>
      addresses.has(user) ? [addresses.get(user)!] : [],
    findWallet: async (user) =>
      addresses.has(user)
        ? { id: "wallet:" + user, address: addresses.get(user)! }
        : null,
    balance,
  };
  return { ...f, balances, addresses, balance };
}
type Fixture = ReturnType<typeof setup>;
async function publish(f: Fixture) {
  const response = await f.call("/proposals", {
    method: "POST",
    body: {
      title: "A neighborhood garden",
      body: "Build a shared place for neighbors to grow ideas.",
    },
  });
  expect(response.status, JSON.stringify(response.data)).toBe(201);
  return response.data;
}
async function open(id: string) {
  await sql(
    "UPDATE musecity.proposals SET starts_at=clock_timestamp()-interval '1 hour',ends_at=clock_timestamp()+interval '3 days' WHERE id=$1",
    [id],
  );
}
async function close(id: string) {
  await sql(
    "UPDATE musecity.proposals SET starts_at=clock_timestamp()-interval '4 days',ends_at=clock_timestamp()-interval '1 second' WHERE id=$1",
    [id],
  );
}
const vote = (
  f: Fixture,
  id: string,
  choice = "for",
  user = "alice",
  key?: string,
) =>
  f.call("/proposals/" + id + "/vote", {
    method: "PUT",
    body: { choice },
    token: "fixture:" + user,
    key,
  });
const read = async (f: Fixture, id: string, user = "alice") =>
  (await f.call("/proposals/" + id, { token: "fixture:" + user })).data;

describe("native weighted governance on isolated PostgreSQL", () => {
  it("gives ordinary accounts 1, exact threshold 10, and one minimal unit below 1", async () => {
    const f = setup();
    expect(
      (await f.call("/me/membership", { token: "fixture:bob" })).data,
    ).toMatchObject({ weight: 1, formalMember: false, wallet: null });
    expect(f.balance).not.toHaveBeenCalled();
    expect((await f.call("/me/membership")).data).toMatchObject({
      weight: 10,
      formalMember: true,
      balance: threshold.toString(),
    });
    f.balances.set("did:privy:alice", threshold - 1n);
    expect((await f.call("/me/membership")).data).toMatchObject({
      weight: 1,
      formalMember: false,
    });
    expect(
      (
        await f.call("/proposals", {
          method: "POST",
          body: { title: "Title", body: "A valid proposal body" },
        })
      ).status,
    ).toBe(403);
  });
  it("fixes the content/rules and schedules 24 hours plus 3 days", async () => {
    const f = setup(),
      p = await publish(f);
    expect(p.status).toBe("announcement");
    expect(Date.parse(p.startsAt) - Date.parse(p.createdAt)).toBe(86400000);
    expect(Date.parse(p.endsAt) - Date.parse(p.startsAt)).toBe(259200000);
    expect((await vote(f, p.id)).data.error.code).toBe("VOTING_CLOSED");
    expect(
      (
        await f.call("/proposals/" + p.id, {
          method: "PATCH",
          body: { title: "Changed" },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await f.call("/proposals", {
          method: "POST",
          body: {
            title: "Title",
            body: "A valid proposal body",
            rules: { quorum: 1 },
          },
        })
      ).status,
    ).toBe(400);
    await open(p.id);
    expect(
      (
        await f.call("/proposals/" + p.id + "/vote", {
          method: "PUT",
          body: { choice: "for", weight: 100, wallet: address },
        })
      ).status,
    ).toBe(400);
  });
  it("rechecks on recasts, replacing weight and choice without recalculating saved votes", async () => {
    const f = setup(),
      p = await publish(f);
    await open(p.id);
    const first = await vote(f, p.id);
    expect(first.data.results).toEqual({
      participants: 1,
      for: 10,
      against: 0,
      abstain: 0,
    });
    f.balances.set("did:privy:alice", 0n);
    expect((await read(f, p.id)).myVote).toEqual(first.data.myVote);
    expect((await vote(f, p.id, "against")).data.results).toEqual({
      participants: 1,
      for: 0,
      against: 1,
      abstain: 0,
    });
    f.balances.set("did:privy:alice", threshold);
    expect((await vote(f, p.id, "abstain")).data.results).toEqual({
      participants: 1,
      for: 0,
      against: 0,
      abstain: 10,
    });
    expect((await vote(f, p.id, "for", "bob")).data.results).toEqual({
      participants: 2,
      for: 1,
      against: 0,
      abstain: 10,
    });
  });
  it("keeps the prior vote on RPC or wallet-verification failure and allows an ordinary voter during RPC failure", async () => {
    const f = setup(),
      p = await publish(f);
    await open(p.id);
    const before = (await vote(f, p.id)).data;
    f.balance.mockRejectedValue(
      new ApiError(503, "RPC_UNAVAILABLE", "RPC unavailable"),
    );
    expect((await vote(f, p.id, "against")).status).toBe(503);
    expect((await read(f, p.id)).myVote).toEqual(before.myVote);
    expect((await vote(f, p.id, "abstain", "bob")).status).toBe(200);
    f.services.wallets!.findWallet = async () => {
      throw new ApiError(503, "WALLET_UNAVAILABLE", "Privy unavailable");
    };
    expect((await vote(f, p.id, "against")).status).toBe(503);
    expect((await read(f, p.id)).myVote).toEqual(before.myVote);
  });
  it("serializes simultaneous votes and makes retries idempotent without rechecking or stale replay", async () => {
    const f = setup(),
      p = await publish(f);
    await open(p.id);
    f.balance.mockClear();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        vote(f, p.id, "for", "alice", "same-vote-key"),
      ),
    );
    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(f.balance).toHaveBeenCalledTimes(1);
    expect(results[4]!.data.results.participants).toBe(1);
    await Promise.all([
      vote(f, p.id, "for", "alice"),
      vote(f, p.id, "against", "alice"),
      vote(f, p.id, "abstain", "alice"),
      vote(f, p.id, "for", "bob"),
    ]);
    const current = await read(f, p.id);
    expect(current.results.participants).toBe(2);
    expect(
      current.results.for + current.results.against + current.results.abstain,
    ).toBe(11);
    const replay = await vote(f, p.id, "for", "alice", "same-vote-key");
    expect(replay.data.myVote).toEqual(current.myVote);
    expect(
      (await vote(f, p.id, "against", "alice", "same-vote-key")).status,
    ).toBe(409);
  });
  it("does not count one 10-weight account as five participants", async () => {
    const f = setup(),
      p = await publish(f);
    await open(p.id);
    await vote(f, p.id);
    await close(p.id);
    expect((await read(f, p.id)).status).toBe("failed");
    expect((await vote(f, p.id, "against")).data.error.code).toBe(
      "VOTING_CLOSED",
    );
  });
  it("counts abstentions in quorum, fails ties and passes only a greater For weight", async () => {
    const f = setup(),
      p = await publish(f);
    await open(p.id);
    f.balances.set("did:privy:alice", 0n);
    for (const [user, choice] of [
      ["alice", "for"],
      ["bob", "for"],
      ["carol", "against"],
      ["dave", "against"],
      ["eve", "abstain"],
    ])
      expect((await vote(f, p.id, choice, user)).status).toBe(200);
    await close(p.id);
    expect((await read(f, p.id)).status).toBe("failed");
    await open(p.id);
    f.balances.set("did:privy:alice", threshold);
    await vote(f, p.id);
    await close(p.id);
    const passed = await read(f, p.id);
    expect(passed.status).toBe("passed");
    expect(passed.results).toEqual({
      participants: 5,
      for: 11,
      against: 2,
      abstain: 1,
    });
  });
  it("checks the deadline again after a slow balance lookup and rolls back the recast", async () => {
    const f = setup(),
      p = await publish(f);
    await open(p.id);
    const old = (await vote(f, p.id)).data.myVote;
    await sql(
      "UPDATE musecity.proposals SET ends_at=clock_timestamp()+interval '400 milliseconds' WHERE id=$1",
      [p.id],
    );
    f.balance.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 550));
      return 0n;
    });
    expect((await vote(f, p.id, "against")).data.error.code).toBe(
      "VOTING_CLOSED",
    );
    expect((await read(f, p.id)).myVote).toEqual(old);
  });
  it("preserves cancellation and rejects other authors, restricted accounts and hidden proposal replays", async () => {
    const f = setup(),
      p = await publish(f);
    await open(p.id);
    await vote(f, p.id);
    expect(
      (
        await f.call(`/proposals/${p.id}/cancel`, {
          token: "fixture:bob",
          method: "POST",
          body: { reason: "No longer needed", confirmed: true },
        })
      ).status,
    ).toBe(409);
    const cancelled = await f.call(`/proposals/${p.id}/cancel`, {
      method: "POST",
      body: { reason: "We need a revised plan", confirmed: true },
    });
    expect(cancelled.data.status).toBe("cancelled");
    expect(cancelled.data.results.for).toBe(10);
    expect((await vote(f, p.id)).data.error.code).toBe("PROPOSAL_CANCELLED");
    const p2 = await publish(f);
    await open(p2.id);
    await vote(f, p2.id, "for", "alice", "hidden-replay-key");
    await sql("UPDATE musecity.proposals SET blocked=true WHERE id=$1", [
      p2.id,
    ]);
    expect(
      (await vote(f, p2.id, "for", "alice", "hidden-replay-key")).status,
    ).toBe(404);
    await f.call("/me", { token: "fixture:bob" });
    await sql(
      "UPDATE musecity.accounts SET status='restricted' WHERE privy_user_id='did:privy:bob'",
    );
    expect((await vote(f, p.id, "for", "bob")).status).toBe(403);
  });
  it("uses proposal reporting, moderation and account block boundaries", async () => {
    const f = setup(),
      p = await publish(f);
    const bob = (await f.call("/me", { token: "fixture:bob" })).data;
    const report = await f.call("/reports", {
      token: "fixture:bob",
      method: "POST",
      body: {
        targetKind: "proposal",
        targetId: p.id,
        reason: "Needs moderation review",
      },
    });
    expect(report.status).toBe(201);
    await sql("INSERT INTO musecity.moderators(account_id) VALUES($1)", [
      bob.id,
    ]);
    const queue = (
      await f.call("/moderation/reports", { token: "fixture:bob" })
    ).data;
    expect(queue.items[0].targetPath).toBe("/governance/" + p.id);
    expect(queue.items[0].preview).toContain(p.title);
    await f.call("/moderation/reports/" + report.data.id, {
      token: "fixture:bob",
      method: "POST",
      body: { action: "hide", confirmed: true },
    });
    expect((await f.call("/proposals/" + p.id, { token: null })).status).toBe(
      404,
    );
    await f.call("/moderation/reports/" + report.data.id, {
      token: "fixture:bob",
      method: "POST",
      body: { action: "restore", confirmed: true },
    });
    expect((await f.call("/proposals/" + p.id, { token: null })).status).toBe(
      200,
    );
    await sql(
      "INSERT INTO musecity.blocks(blocker_id,blocked_id) VALUES($1,$2)",
      [bob.id, p.owner.id],
    );
    expect(
      (await f.call("/proposals/" + p.id, { token: "fixture:bob" })).status,
    ).toBe(404);
    expect(
      (await f.call("/proposals", { token: "fixture:bob" })).data.items,
    ).toEqual([]);
  });
  it("allows operators to record actual execution once after a successful vote", async () => {
    const f = setup(),
      p = await publish(f);
    await open(p.id);
    for (const user of ["alice", "bob", "carol", "dave", "eve"])
      await vote(f, p.id, "for", user);
    const path = `/proposals/${p.id}/execution`,
      body = {
        result: "The community garden has been opened.",
        confirmed: true,
      };
    expect((await f.call(path, { method: "POST", body })).status).toBe(403);
    await sql("INSERT INTO musecity.moderators(account_id) VALUES($1)", [
      p.owner.id,
    ]);
    expect((await f.call(path, { method: "POST", body })).status).toBe(409);
    await close(p.id);
    const saved = await f.call(path, {
      method: "POST",
      body,
      key: "execute-once-key",
    });
    expect(saved.status).toBe(200);
    expect(saved.data.execution.result).toBe(body.result);
    expect(
      (await f.call(path, { method: "POST", body, key: "execute-once-key" }))
        .data.execution,
    ).toEqual(saved.data.execution);
    expect((await f.call(path, { method: "POST", body })).status).toBe(409);
  });
  it("rejects Agent credentials for membership and governance even with all existing scopes", async () => {
    const f = setup(),
      p = await publish(f);
    await open(p.id);
    const invite = await f.call("/me/agent-invitations", {
      method: "POST",
      body: { name: "Fixture Muse", scopes, confirmed: true },
    });
    const register = await f.call("/agent-registrations", {
      token: null,
      method: "POST",
      body: {
        name: "Fixture Muse",
        requestedScopes: scopes,
        invitationToken: invite.data.invitationToken,
      },
    });
    const activate = await f.call(
      `/agent-registrations/${register.data.registrationId}/activate`,
      { token: register.data.registrationToken, method: "POST" },
    );
    const token = activate.data.credential.token;
    expect(activate.status).toBe(201);
    expect(typeof token).toBe("string");
    for (const [path, method, body] of [
      ["/me/membership", "GET", undefined],
      ["/proposals", "GET", undefined],
      [`/proposals/${p.id}`, "GET", undefined],
      [
        "/proposals",
        "POST",
        { title: "Hello", body: "An agent cannot create proposals" },
      ],
      [`/proposals/${p.id}/vote`, "PUT", { choice: "for" }],
      [
        `/proposals/${p.id}/cancel`,
        "POST",
        { reason: "Agent cannot cancel", confirmed: true },
      ],
      [
        `/proposals/${p.id}/execution`,
        "POST",
        { result: "Agent cannot execute", confirmed: true },
      ],
    ] as const)
      expect((await f.call(path, { token, method, body })).status).toBe(403);
  });
  it("allows transferred tokens to qualify another account without changing the original recorded vote", async () => {
    const f = setup(),
      p = await publish(f);
    await open(p.id);
    await vote(f, p.id);
    f.balances.set("did:privy:alice", 0n);
    f.addresses.set(
      "did:privy:bob",
      "0x2222222222222222222222222222222222222222",
    );
    f.balances.set("did:privy:bob", threshold);
    const bob = await vote(f, p.id, "for", "bob");
    expect(bob.data.results).toMatchObject({ participants: 2, for: 20 });
    expect(Object.keys(bob.data.myVote).sort()).toEqual([
      "checkedAt",
      "choice",
      "weight",
    ]);
    const anonymous = await f.call("/proposals/" + p.id, { token: null });
    expect(anonymous.data.myVote).toBeNull();
    expect(JSON.stringify(anonymous.data)).not.toContain(address);
    f.addresses.set("did:privy:bob", address);
    expect((await vote(f, p.id, "against", "bob")).data.error.code).toBe(
      "WALLET_CONFLICT",
    );
    expect((await read(f, p.id)).results.for).toBe(20);
  });
  it("documents strict human-only bodies, idempotency and response shapes", async () => {
    const f = setup();
    const response = await f.app.request("http://localhost/openapi.json");
    const doc = (await response.json()) as any;
    const vote = doc.paths["/proposals/{id}/vote"].put;
    const body = vote.requestBody.content["application/json"].schema;
    expect(body.additionalProperties).toBe(false);
    expect(Object.keys(body.properties)).toEqual(["choice"]);
    expect(
      vote.parameters.some(
        (p: any) => p.name === "Idempotency-Key" && p.required,
      ),
    ).toBe(true);
    expect(
      vote.responses["200"].content["application/json"].schema.properties
        .myVote,
    ).toBeDefined();
    expect(
      doc.paths["/me/membership"].get.responses["200"].content[
        "application/json"
      ].schema.properties.weight.enum,
    ).toEqual([1, 10]);
  });
});
