import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { activate, connectionStatus } from "../src/server/agents";
import { actor } from "../src/server/auth";
import { digest } from "../src/server/crypto";
import { withDatabase, type Database } from "../src/server/database";
import { ApiError } from "../src/server/errors";
import {
  bindingStillHeld,
  controllersFor,
  directory,
  myMuses,
  publicMuse,
} from "../src/server/muses";
import type { AccountRow } from "../src/server/schema";
import { placeIds } from "../src/shared/muses";
import { config, fixture, reset } from "./helpers";
import { addresses, withMuses } from "./muse-fakes";

beforeEach(reset);
type Fixture = ReturnType<typeof withMuses>;
const start = (f: Fixture, token = "fixture:alice", id = 1) =>
  f.call(`/me/muses/${id}/start`, { method: "POST", token });
const redeem = (f: Fixture, otp: string) =>
  f.call("/agent-connections", { token: null, method: "POST", body: { otp } });
const rows = () =>
  withDatabase(config.testAdminUrl, (d) =>
    d.query<any>("SELECT * FROM musecity.muse_bindings ORDER BY started_at,id"),
  );
const step = (data: any, id: string) =>
  data.steps.find((s: any) => s.id === id);
const museDeps = (f: Fixture) => ({
  musegod: f.musegod,
  chain: f.chain,
  wallets: f.wallets,
  origin: f.services.origin,
});
async function seedDirectoryBindings(
  d: Database,
  ownerId: string,
  count: number,
) {
  await d.query(
    "INSERT INTO musecity.agents(id,owner_account_id,name,scopes,last_active_at) SELECT 'directory-agent-'||n,$1,'Muse '||n,'[]'::jsonb,now() FROM generate_series(1,$2::integer) n ON CONFLICT DO NOTHING",
    [ownerId, count],
  );
  await d.query(
    "INSERT INTO musecity.registrations(id,name,requested_scopes,owner_account_id,token_hash,status,expires_at,agent_id) SELECT 'directory-registration-'||n,'Muse '||n,'[]'::jsonb,$1,'directory-code-'||n,'activated',now()-interval '1 day','directory-agent-'||n FROM generate_series(1,$2::integer) n ON CONFLICT DO NOTHING",
    [ownerId, count],
  );
  await d.query(
    "INSERT INTO musecity.credentials(id,agent_id,token_hash,prefix,expires_at) SELECT 'directory-credential-'||n,'directory-agent-'||n,'directory-secret-'||n,'fixture',now()+interval '1 day' FROM generate_series(1,$1::integer) n ON CONFLICT DO NOTHING",
    [count],
  );
  await d.query(
    "INSERT INTO musecity.muse_bindings(id,token_id,agent_id_8004,account_id,registration_id,agent_id,holder_address,description) SELECT 'directory-binding-'||n,n,6591+n,$1,'directory-registration-'||n,'directory-agent-'||n,$3,'' FROM generate_series(1,$2::integer) n ON CONFLICT DO NOTHING",
    [ownerId, count, addresses.alice],
  );
  await d.query(
    "INSERT INTO musecity.muse_reports(binding_id,step,status) SELECT 'directory-binding-'||n,step,status FROM generate_series(1,$1::integer) n CROSS JOIN (VALUES ('soul','done'),('look','skipped')) reports(step,status) ON CONFLICT DO NOTHING",
    [count],
  );
}
async function connected(f: Fixture) {
  const created = await start(f);
  expect(created.status).toBe(201);
  const active = await redeem(f, created.data.otp);
  expect(active.status).toBe(201);
  await f.call("/agent", { token: active.data.credential.token });
  return active;
}

describe("muse pages and keeper bindings with isolated PostgreSQL", () => {
  it("resolves ids, hashes and names; 404s the rest", async () => {
    const f = withMuses(fixture());
    for (const ref of ["1", "%231", "bard", "BARD", "%20Bard%20"])
      expect(
        (await f.call(`/muses/${ref}`, { token: null })).data.muse.id,
      ).toBe(1);
    const bastion = [...f.records.values()].find((m) =>
      m.name.startsWith("Bastion:"),
    )!;
    expect(
      (
        await f.call(`/muses/${encodeURIComponent(bastion.name)}`, {
          token: null,
        })
      ).data.muse.id,
    ).toBe(bastion.id);
    for (const ref of ["0", "1000", "01", "1.0", "xyz", "%%", "%25231"])
      expect(await f.call(`/muses/${ref}`, { token: null })).toMatchObject({
        status: 404,
        data: { error: { code: "MUSE_NOT_FOUND" } },
      });
  });

  it("public view hides keeper secrets", async () => {
    const f = withMuses(fixture());
    const created = await start(f);
    expect(created.status).toBe(201);
    const publicView = await f.call("/muses/1", { token: null });
    expect(publicView.status).toBe(200);
    expect(publicView.data).toMatchObject({
      keeper: addresses.alice,
      muse: { name: "Bard", page: "https://musegod.org/muse/1" },
    });
    const json = JSON.stringify(publicView.data);
    for (const secret of [
      '"otp"',
      '"connectionId"',
      '"pending":',
      created.data.otp,
      created.data.line,
    ])
      expect(json).not.toContain(secret);
    expect(publicView.data).not.toHaveProperty("line");
    expect(created.data.line).toBe(
      `Be muse #1 (read https://musegod.org/muse/1.txt), then set yourself up by following http://localhost/muses/1/start.md with code ${created.data.otp}`,
    );
    expect(created.data.expiresAt).toEqual(expect.any(String));
  });

  it("keeper via external linked wallet", async () => {
    const f = withMuses(fixture());
    f.setOwner(1, addresses.external);
    f.controllers.set(6592, new Set([addresses.external]));
    expect((await start(f)).status).toBe(201);
    expect((await f.call("/me/muses/1")).data.controllers).toEqual([
      addresses.external,
    ]);
    expect((await rows())[0].holder_address).toBe(addresses.external);
  });

  it("keeper via delegate", async () => {
    const f = withMuses(fixture());
    f.linked.set("did:privy:alice", [addresses.alice, addresses.delegate]);
    f.controllers.set(6592, new Set([addresses.delegate]));
    expect((await start(f)).status).toBe(201);
    expect((await f.call("/me/muses/1")).data.controllers).toEqual([
      addresses.delegate,
    ]);
  });

  it("non-keeper gets 403 on every private muse operation", async () => {
    const f = withMuses(fixture());
    for (const [path, method] of [
      ["/me/muses/1", "GET"],
      ["/me/muses/1/start", "POST"],
      ["/me/muses/1/restart", "POST"],
    ])
      expect(
        await f.call(path, { method, token: "fixture:bob" }),
      ).toMatchObject({
        status: 403,
        data: { error: { code: "NOT_MUSE_KEEPER" } },
      });
    expect(await rows()).toHaveLength(0);
  });

  it("second start replaces the pending code", async () => {
    const f = withMuses(fixture());
    const first = await start(f),
      second = await start(f);
    expect([first.status, second.status]).toEqual([201, 201]);
    expect((await rows()).filter((b) => b.ended_at === null)).toHaveLength(1);
    expect(
      (await rows()).find((b) => b.registration_id === first.data.connectionId)
        .end_reason,
    ).toBe("restarted");
    expect(await redeem(f, first.data.otp)).toMatchObject({
      status: 401,
      data: { error: { code: "INVALID_CREDENTIAL" } },
    });
    expect((await redeem(f, second.data.otp)).status).toBe(201);
  });

  it("serializes simultaneous starts with a single newest usable code", async () => {
    const f = withMuses(fixture());
    const results = await Promise.all([start(f), start(f)]);
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    const active = (await rows()).filter((b) => b.ended_at === null);
    expect(active).toHaveLength(1);
    for (const result of results)
      expect((await redeem(f, result.data.otp)).status).toBe(
        result.data.connectionId === active[0].registration_id ? 201 : 401,
      );
  });

  it("finishes transfer cleanup alongside in-flight redemption without a lock inversion", async () => {
    const f = withMuses(fixture());
    const created = await start(f);
    f.setOwner(1, addresses.stranger);
    let publicRead!: ReturnType<typeof f.call>;
    const active = await withDatabase(config.testAdminUrl, (d) =>
      d.transaction(async () => {
        await d.query(
          "SELECT id FROM musecity.registrations WHERE id=$1 FOR UPDATE",
          [created.data.connectionId],
        );
        publicRead = f.call("/muses/1", { token: null });
        await vi.waitFor(
          async () => {
            const waiting = await withDatabase(config.testAdminUrl, (other) =>
              other.one<{ n: string }>(
                "SELECT count(*) AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'UPDATE musecity.registrations SET status=%'",
              ),
            );
            expect(Number(waiting?.n)).toBe(1);
          },
          { timeout: 2000 },
        );
        return activate(d, created.data.connectionId, created.data.otp);
      }),
    );
    expect(active.agentId).toEqual(expect.any(String));
    expect(await publicRead).toMatchObject({
      status: 200,
      data: { startedAt: null },
    });
    expect((await rows())[0].end_reason).toBe("transferred");
  });

  it("redeeming binds the Agent with the NFT's name and description", async () => {
    const f = withMuses(fixture());
    f.records.get(1)!.soul!.intro = "B".repeat(600);
    const created = await start(f),
      active = await redeem(f, created.data.otp);
    const identity = await f.call("/agent", {
      token: active.data.credential.token,
    });
    expect(identity.data).toMatchObject({
      name: "Bard",
      publicVisible: true,
      description: ("muse #1 of MUSEGOD. " + "B".repeat(600)).slice(0, 500),
    });
    expect((await rows())[0]).toMatchObject({
      agent_id: active.data.agentId,
      registration_id: created.data.connectionId,
      agent_id_8004: 6592,
    });
    f.chain.bindingOf.mockClear();
    f.musegod.muse.mockResolvedValueOnce({
      value: {
        ...f.records.get(1)!,
        agent: { agentId: 999999, wallet: addresses.agent },
      },
      asOf: new Date().toISOString(),
      stale: false,
    });
    expect((await f.call("/me/muses/1")).status).toBe(200);
    expect(f.chain.bindingOf).not.toHaveBeenCalled();
    expect(f.chain.isController).toHaveBeenLastCalledWith(
      6592,
      addresses.external,
    );
  });

  it("steps 3 and 4 come from musegod.ai", async () => {
    const f = withMuses(fixture());
    const created = await start(f),
      active = await redeem(f, created.data.otp);
    const token = active.data.credential.token;
    expect(
      step((await f.call("/muses/1", { token: null })).data, "movein").status,
    ).toBe("pending");
    await f.call("/agent", { token });
    expect(
      step((await f.call("/muses/1", { token: null })).data, "movein"),
    ).toMatchObject({ status: "done", source: "musegod.ai" });
    await f.call("/me", {
      method: "PATCH",
      body: { name: "Alice", bio: "Keeper", avatarMediaId: null, join: true },
    });
    const post = await f.call("/posts", {
      method: "POST",
      token,
      body: { kind: "update", text: "Hello from Bard." },
    });
    expect(post.status).toBe(201);
    expect(
      step((await f.call("/muses/1", { token: null })).data, "hello"),
    ).toMatchObject({
      status: "done",
      source: "musegod.ai",
      evidence: `/posts/${post.data.id}`,
    });
    await withDatabase(config.testAdminUrl, (d) =>
      d.query("UPDATE musecity.posts SET blocked=true WHERE id=$1", [
        post.data.id,
      ]),
    );
    expect(
      step((await f.call("/muses/1", { token: null })).data, "hello").status,
    ).toBe("pending");
  });

  it("sale ends the binding; a move to the muse's own wallet does not", async () => {
    const f = withMuses(fixture());
    const active = await connected(f);
    f.setOwner(1, addresses.agent);
    expect(
      (await f.call("/muses/1", { token: null })).data.startedAt,
    ).not.toBeNull();
    f.setOwner(1, addresses.stranger);
    expect(
      (await f.call("/muses/1", { token: null })).data.startedAt,
    ).toBeNull();
    expect((await rows())[0].end_reason).toBe("transferred");
    expect(
      (await f.call("/agent", { token: active.data.credential.token })).status,
    ).toBe(200);
  });

  it("confirms apparent transfers on chain and retains other linked wallets", async () => {
    const f = withMuses(fixture());
    await start(f);
    f.records.get(1)!.owner = addresses.stranger;
    expect(
      (await f.call("/muses/1", { token: null })).data.startedAt,
    ).not.toBeNull();
    f.owners.set(1, addresses.external);
    expect(
      (await f.call("/muses/1", { token: null })).data.startedAt,
    ).not.toBeNull();
    f.owners.set(1, addresses.stranger);
    f.controllers.set(6592, new Set([addresses.alice]));
    expect((await f.call("/me/muses/1")).data.binding).toBeNull();
    expect((await rows())[0].end_reason).toBe("transferred");
  });

  it("protects a still-held binding from another account and allows a new keeper after sale", async () => {
    const f = withMuses(fixture());
    const old = await start(f);
    f.controllers.get(6592)!.add(addresses.bob);
    expect(await start(f, "fixture:bob")).toMatchObject({
      status: 409,
      data: { error: { code: "MUSE_KEPT_ELSEWHERE" } },
    });
    f.setOwner(1, addresses.bob);
    const next = await start(f, "fixture:bob");
    expect(next.status).toBe(201);
    expect(
      (await rows()).find((b) => b.registration_id === old.data.connectionId)
        .end_reason,
    ).toBe("transferred");
    expect((await redeem(f, old.data.otp)).status).toBe(401);
  });

  it("renders from catalog when the muse record is unavailable", async () => {
    const f = withMuses(fixture());
    f.musegod.muse.mockRejectedValue(
      new ApiError(503, "MUSEGOD_UNAVAILABLE", "Unavailable."),
    );
    const result = await f.call("/muses/1", { token: null });
    expect(result).toMatchObject({
      status: 200,
      data: {
        muse: { id: 1, name: "Bard", intro: null },
        asOf: null,
        placesAvailable: false,
      },
    });
    for (const place of placeIds)
      expect(step(result.data, place)).toMatchObject({
        status: "pending",
        evidence: null,
      });
  });

  it("directory filters and counts", async () => {
    const f = withMuses(fixture());
    const active = await connected(f);
    f.gallery.muses.push({ id: 1, linked: ["flock", "x"] });
    let result = await f.call("/muses?filter=awake", { token: null });
    expect(result.data.items).toEqual([
      {
        id: 1,
        name: "Bard",
        thumb: f.records.get(1)!.images.thumb,
        done: 3,
        awake: true,
        started: true,
      },
    ]);
    expect(result.data.counts).toEqual({ awake: 1, living: 125, complete: 0 });
    expect(
      (await f.call("/muses?q=bard", { token: null })).data.items.map(
        (m: any) => m.id,
      ),
    ).toEqual([1]);
    expect(
      (await f.call("/muses?q=%231", { token: null })).data.items.map(
        (m: any) => m.id,
      ),
    ).toEqual([1]);
    expect(
      (await f.call("/muses?filter=mine")).data.items.map((m: any) => m.id),
    ).toEqual([1]);
    expect(
      (await f.call("/muses?filter=mine", { token: "fixture:bob" })).data.items,
    ).toEqual([]);
    expect((await f.call("/muses?filter=mine", { token: null })).status).toBe(
      401,
    );
    expect(
      (await f.call("/muses?filter=not_started", { token: null })).data.items,
    ).toHaveLength(998);
    expect(
      (await f.call("/muses?filter=complete", { token: null })).data.items,
    ).toEqual([]);
    expect((await f.call("/muses?filter=wrong", { token: null })).status).toBe(
      400,
    );
    expect((await f.call("/me/muses")).data.map((m: any) => m.id)).toEqual([1]);
    expect((await f.call("/me/muses", { token: "fixture:bob" })).data).toEqual(
      [],
    );
    expect(
      (
        await f.call("/muses?filter=mine", {
          token: active.data.credential.token,
        })
      ).status,
    ).toBe(403);
  });

  it("reads directory progress in one query at every active-binding count", async () => {
    const f = withMuses(fixture());
    await withDatabase(config.testAdminUrl, async (d) => {
      const a = await actor(d, { kind: "human", userId: "did:privy:alice" });
      const queryCounts: number[] = [];
      for (const count of [0, 1, 12, 99, 999]) {
        await seedDirectoryBindings(d, a.account.id, count);
        const query = vi.spyOn(d, "query");
        try {
          const result = await directory(d, museDeps(f), new URLSearchParams());
          queryCounts.push(query.mock.calls.length);
          expect(result.items).toHaveLength(999);
          expect(result.counts.awake).toBe(count);
          expect(result.items.filter((m) => m.started)).toHaveLength(count);
          expect(
            result.items.filter((m) => m.started).every((m) => m.done === 2),
          ).toBe(true);
        } finally {
          query.mockRestore();
        }
      }
      expect(queryCounts).toEqual([1, 1, 1, 1, 1]);
    });
  });

  it("computes myMuses only for owned entries, without reading other bindings", async () => {
    const f = withMuses(fixture());
    f.setOwner(2, addresses.external);
    f.gallery.muses.push({ id: 1, linked: ["x"] });
    await withDatabase(config.testAdminUrl, async (d) => {
      const alice = await actor(d, {
        kind: "human",
        userId: "did:privy:alice",
      });
      const bob = await actor(d, { kind: "human", userId: "did:privy:bob" });
      await seedDirectoryBindings(d, alice.account.id, 999);
      const query = vi.spyOn(d, "query");
      try {
        const mine = await myMuses(d, museDeps(f), alice);
        expect(mine.map((m) => [m.id, m.done])).toEqual([
          [1, 3],
          [2, 2],
        ]);
        expect(query).toHaveBeenCalledTimes(1);
        const returned = await query.mock.results[0].value;
        expect(
          returned.map((row: { token_id: number }) => row.token_id).sort(),
        ).toEqual([1, 2]);
        query.mockClear();
        expect(await myMuses(d, museDeps(f), bob)).toEqual([]);
        expect(query).not.toHaveBeenCalled();
      } finally {
        query.mockRestore();
      }
    });
  });

  it("keeps batched awake status equivalent to connectionStatus and the detail page", async () => {
    const f = withMuses(fixture());
    await withDatabase(config.testAdminUrl, async (d) => {
      const a = await actor(d, { kind: "human", userId: "did:privy:alice" });
      await seedDirectoryBindings(d, a.account.id, 1);
      for (const state of [
        { status: "waiting", registered: false },
        { status: "expired", registered: false, expiredCode: true },
        { status: "cancelled", registered: false, cancelled: true },
        { status: "awaiting_verification", unverified: true },
        { status: "connected", expiredCode: true },
        { status: "paused", agentStatus: "paused" },
        { status: "revoked", agentStatus: "revoked" },
        { status: "revoked", expiredCredential: true },
        { status: "revoked", revokedCredential: true },
        { status: "connected", restricted: true },
        { status: "connected", joined: true, publicVisible: true },
      ]) {
        await d.query(
          "UPDATE musecity.registrations SET agent_id=$1,status=$2,expires_at=now()+($3::integer * interval '1 day') WHERE id='directory-registration-1'",
          [
            state.registered === false ? null : "directory-agent-1",
            state.cancelled ? "cancelled" : "activated",
            state.expiredCode ? -1 : 1,
          ],
        );
        await d.query(
          "UPDATE musecity.agents SET status=$1,last_active_at=CASE WHEN $2 THEN NULL ELSE now() END,public_visible=$3 WHERE id='directory-agent-1'",
          [
            state.agentStatus ?? "active",
            state.unverified ?? false,
            state.publicVisible ?? false,
          ],
        );
        await d.query(
          "UPDATE musecity.credentials SET revoked_at=CASE WHEN $1 THEN now() ELSE NULL END,expires_at=now()+($2::integer * interval '1 day') WHERE id='directory-credential-1'",
          [state.revokedCredential ?? false, state.expiredCredential ? -1 : 1],
        );
        await d.query(
          "UPDATE musecity.accounts SET status=$2,joined_at=CASE WHEN $3 THEN now() ELSE NULL END WHERE id=$1",
          [
            a.account.id,
            state.restricted ? "restricted" : "active",
            state.joined ?? false,
          ],
        );
        const account = (await d.one<AccountRow>(
          "SELECT * FROM musecity.accounts WHERE id=$1",
          [a.account.id],
        ))!;
        const status = await connectionStatus(
          d,
          { ...a, account },
          "directory-registration-1",
        );
        expect(status.status, JSON.stringify(state)).toBe(state.status);
        const list = await directory(d, museDeps(f), new URLSearchParams());
        const detail = await publicMuse(d, museDeps(f), "1");
        expect(list.items[0].awake, JSON.stringify(state)).toBe(
          status.status === "connected" && account.status === "active",
        );
        expect(list.items[0].done, JSON.stringify(state)).toBe(
          detail.progress.done,
        );
      }
      await d.query(
        "DELETE FROM musecity.credentials WHERE id='directory-credential-1'",
      );
      expect(
        (await connectionStatus(d, a, "directory-registration-1")).status,
      ).toBe("revoked");
      expect(
        (await directory(d, museDeps(f), new URLSearchParams())).items[0].awake,
      ).toBe(false);
    });
  });

  it("keeps batched reports and hello evidence equivalent across hidden posts and ended bindings", async () => {
    const f = withMuses(fixture());
    await withDatabase(config.testAdminUrl, async (d) => {
      const a = await actor(d, { kind: "human", userId: "did:privy:alice" });
      const bob = await actor(d, { kind: "human", userId: "did:privy:bob" });
      await seedDirectoryBindings(d, a.account.id, 1);
      await d.query(
        "INSERT INTO musecity.posts(id,owner_account_id,agent_id,kind,text,blocked,deleted) VALUES('blocked',$1,'directory-agent-1','update','hidden',true,false),('deleted',$1,'directory-agent-1','update','gone',false,true),('other-owner',$2,'directory-agent-1','update','wrong owner',false,false),('human',$1,NULL,'update','human',false,false)",
        [a.account.id, bob.account.id],
      );
      const check = async (done: number) => {
        const list = await directory(d, museDeps(f), new URLSearchParams());
        const detail = await publicMuse(d, museDeps(f), "1");
        expect(list.items[0].done).toBe(done);
        expect(list.items[0].done).toBe(detail.progress.done);
        return detail;
      };
      expect(step(await check(2), "hello").status).toBe("pending");
      await d.query(
        "UPDATE musecity.posts SET blocked=false WHERE id='blocked'",
      );
      expect(step(await check(3), "hello").evidence).toBe("/posts/blocked");
      await d.query(
        "UPDATE musecity.posts SET deleted=false WHERE id='deleted'",
      );
      await d.query(
        "UPDATE musecity.posts SET blocked=true WHERE id='blocked'",
      );
      expect(step(await check(3), "hello").evidence).toBe("/posts/deleted");
      await d.query(
        "UPDATE musecity.muse_reports SET status='done' WHERE step='look'",
      );
      await check(4);
      await d.query(
        "UPDATE musecity.muse_reports SET status='needs_you' WHERE step='soul'",
      );
      await check(3);
      await d.query(
        "UPDATE musecity.accounts SET status='restricted' WHERE id=$1",
        [a.account.id],
      );
      await check(1);
      await d.query(
        "UPDATE musecity.accounts SET status='active' WHERE id=$1",
        [a.account.id],
      );
      await d.query(
        "UPDATE musecity.muse_bindings SET ended_at=now(),end_reason='restarted'",
      );
      const detail = await check(0);
      expect(detail.startedAt).toBeNull();
    });
  });

  it("does not turn unavailable gallery evidence into zero living muses", async () => {
    const f = withMuses(fixture());
    f.musegod.gallery.mockRejectedValue(
      new ApiError(503, "MUSEGOD_UNAVAILABLE", "Unavailable."),
    );
    expect(await f.call("/muses", { token: null })).toMatchObject({
      status: 503,
      data: { error: { code: "MUSEGOD_UNAVAILABLE" } },
    });
  });

  it("controllersFor can check a bound Agent's owner without granting human management access", async () => {
    const f = withMuses(fixture());
    const active = await connected(f);
    const result = await withDatabase(config.testUrl, (d) =>
      d.transaction(async () => {
        const a = await actor(
          d,
          {
            kind: "agent",
            tokenHash: await digest(active.data.credential.token),
          },
          "content:read",
        );
        return controllersFor(
          {
            musegod: f.musegod,
            chain: f.chain,
            wallets: f.wallets,
            origin: f.services.origin,
          },
          a,
          1,
        );
      }),
    );
    expect(result).toEqual({
      agentId8004: 6592,
      controllers: [addresses.alice],
    });
    expect((await start(f, active.data.credential.token)).status).toBe(403);
  });

  it("warns at the Agent limit", async () => {
    const f = withMuses(fixture());
    const owner = await f.call("/me");
    await withDatabase(config.testAdminUrl, (d) =>
      d.query(
        "INSERT INTO musecity.agents(id,owner_account_id,name,scopes) SELECT 'limit-'||n,$1,'Existing Agent','[]'::jsonb FROM generate_series(1,20) n",
        [owner.data.id],
      ),
    );
    expect((await f.call("/me/muses/1")).data.agentLimitReached).toBe(true);
    expect(await start(f)).toMatchObject({
      status: 409,
      data: { error: { code: "AGENT_LIMIT" } },
    });
    expect(await rows()).toHaveLength(0);
  });

  it("restarts without deleting the former Agent, and invalidates pending codes", async () => {
    const f = withMuses(fixture());
    const active = await connected(f);
    expect(
      await f.call("/me/muses/1/restart", { method: "POST" }),
    ).toMatchObject({ status: 200, data: { restarted: true } });
    expect(
      (await f.call("/muses/1", { token: null })).data.startedAt,
    ).toBeNull();
    expect(
      (await f.call("/agent", { token: active.data.credential.token })).status,
    ).toBe(200);
    const pending = await start(f);
    await f.call("/me/muses/1/restart", { method: "POST" });
    expect((await redeem(f, pending.data.otp)).status).toBe(401);
  });

  it("refuses an invalid immutable binding before creating a connection", async () => {
    const f = withMuses(fixture());
    f.bindings.set(6592, {
      standard: 0,
      contract: addresses.stranger,
      tokenId: 1,
    });
    expect((await start(f)).status).toBe(503);
    expect(await rows()).toHaveLength(0);
  });

  it("projects stored reports, signatures and pot into the keeper's Needs you", async () => {
    const f = withMuses(fixture());
    const created = await start(f);
    const binding = (await rows())[0];
    await withDatabase(config.testAdminUrl, async (d) => {
      await d.query(
        "INSERT INTO musecity.muse_reports(binding_id,step,status,url,founding_number,wallet_address,code) VALUES($1,'soul','done',NULL,NULL,NULL,NULL),($1,'terrakin','done','https://terrakin.org/r/r_0123456789abcdef',NULL,NULL,NULL),($1,'flock','done',NULL,12,NULL,NULL),($1,'opensea','needs_you',NULL,NULL,$2,'opensea_link'),($1,'x','needs_you',NULL,NULL,NULL,'verification_code')",
        [binding.id, addresses.agent],
      );
      await d.query(
        "INSERT INTO musecity.muse_signatures(id,binding_id,kind,place,line,signer,signature,state) VALUES('queued',$1,'lives_at','terrakin','stored line',$2,'0x','queued')",
        [binding.id, addresses.alice],
      );
    });
    const result = await f.call("/me/muses/1");
    expect(result.status).toBe(200);
    expect(result.data.binding.connection).toMatchObject({
      connectionId: created.data.connectionId,
      status: "waiting",
    });
    expect(result.data.reports).toContainEqual({
      step: "soul",
      status: "done",
      at: expect.any(String),
    });
    expect(result.data.needsYou).toMatchObject({
      sending: 1,
      openseaLink: addresses.agent,
      verificationCode: true,
      pot: { closes: f.week.closes },
    });
    expect(result.data.needsYou.sign.map((line: any) => line.kind)).toEqual([
      "flock_claim",
      "elsewhere",
      "muse_link",
    ]);
    expect(
      step((await f.call("/muses/1", { token: null })).data, "soul"),
    ).toMatchObject({ status: "done", source: "reported" });
    f.week.muses.push(1);
    expect((await f.call("/me/muses/1")).data.needsYou.pot).toBeNull();
  });

  it("private routes reject Agent credentials and invalid token ids", async () => {
    const f = withMuses(fixture());
    const active = await connected(f);
    for (const [path, method] of [
      ["/me/muses", "GET"],
      ["/me/muses/1", "GET"],
      ["/me/muses/1/start", "POST"],
      ["/me/muses/1/restart", "POST"],
    ]) {
      expect(
        (await f.call(path, { method, token: active.data.credential.token }))
          .status,
      ).toBe(403);
      expect((await f.call(path, { method, token: null })).status).toBe(401);
    }
    for (const ref of ["0", "01", "1.0", "1000", "bard"])
      expect((await f.call(`/me/muses/${ref}`)).status).toBe(404);
    f.services.museChain = undefined;
    expect(await f.call("/muses/1", { token: null })).toMatchObject({
      status: 503,
      data: { error: { code: "MUSES_UNAVAILABLE" } },
    });
  });
});

it("bindingStillHeld recognizes the holder, any linked wallet or the muse's agent wallet", () => {
  const input = {
    holder: addresses.alice,
    linked: [addresses.external],
    agentWallet: addresses.agent,
  };
  for (const ownerOf of [
    addresses.alice,
    addresses.external,
    addresses.agent,
    addresses.alice.toUpperCase(),
  ])
    expect(bindingStillHeld({ ...input, ownerOf })).toBe(true);
  expect(bindingStillHeld({ ...input, ownerOf: addresses.stranger })).toBe(
    false,
  );
  expect(
    bindingStillHeld({ ...input, ownerOf: addresses.agent, agentWallet: null }),
  ).toBe(false);
});

it("keeps Agent activation free of runtime import cycles", () => {
  const visited = new Set<string>();
  const cycles: string[][] = [];
  function visit(file: string, path: string[]) {
    if (path.includes(file)) {
      cycles.push([...path.slice(path.indexOf(file)), file]);
      return;
    }
    if (visited.has(file)) return;
    visited.add(file);
    const source = ts.createSourceFile(
      file,
      readFileSync(file, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    for (const node of source.statements) {
      if (
        !ts.isImportDeclaration(node) ||
        !ts.isStringLiteral(node.moduleSpecifier)
      )
        continue;
      const clause = node.importClause;
      if (clause?.isTypeOnly) continue;
      if (
        clause &&
        !clause.name &&
        clause.namedBindings &&
        ts.isNamedImports(clause.namedBindings) &&
        clause.namedBindings.elements.every((item) => item.isTypeOnly)
      )
        continue;
      const specifier = node.moduleSpecifier.text;
      if (specifier.startsWith("."))
        visit(resolve(dirname(file), specifier + ".ts"), [...path, file]);
    }
  }
  visit(resolve("src/server/agents.ts"), []);
  expect(cycles).toEqual([]);
});
