import { beforeEach, describe, expect, it } from "vitest";
import { fixture, reset, article, config } from "./helpers";
import { withDatabase } from "../src/server/database";
import {
  draftScopes,
  publishScopes,
  type Scope,
} from "../src/shared/contracts";
beforeEach(reset);
const update = { kind: "update", text: "Hello, neighbors!" };
const gardenUpdate = {
  kind: "update",
  text: "I am building an open source garden.",
};
async function join(f: ReturnType<typeof fixture>, who = "alice") {
  const r = await f.call("/me", {
    token: "fixture:" + who,
    method: "PATCH",
    body: {
      name: who,
      bio: "Building for neighbors",
      avatarMediaId: null,
      workingOn: "A neighborhood garden",
      canHelp: "Design reviews",
      join: true,
    },
  });
  expect(r.status, JSON.stringify(r.data)).toBe(200);
  return r.data;
}
async function agent(
  f: ReturnType<typeof fixture>,
  scopes: Scope[] = draftScopes,
) {
  const inv = await f.call("/me/agent-invitations", {
    method: "POST",
    body: { name: "Garden assistant", scopes, confirmed: true },
  });
  const reg = await f.call("/agent-registrations", {
    token: null,
    method: "POST",
    body: {
      name: "Garden assistant",
      requestedScopes: scopes,
      invitationToken: inv.data.invitationToken,
    },
  });
  const active = await f.call(
    "/agent-registrations/" + reg.data.registrationId + "/activate",
    { method: "POST", token: reg.data.registrationToken },
  );
  expect(active.status).toBe(201);
  return { id: active.data.agentId, token: active.data.credential.token };
}
async function publishedWork(
  f: ReturnType<typeof fixture>,
  token = "fixture:alice",
) {
  const w = await f.call("/works", {
    method: "POST",
    token,
    body: { ...article, aiDeclaration: undefined },
  });
  expect(w.status).toBe(201);
  const p = await f.call("/works/" + w.data.workId + "/publish", {
    method: "POST",
    token,
    body: { revisionId: w.data.revisionId },
  });
  expect(p.status).toBe(200);
  return p.data;
}
async function makeModerator(accountId: string) {
  await withDatabase(config.testAdminUrl, (d) =>
    d.query("INSERT INTO musecity.moderators(account_id) VALUES($1)", [
      accountId,
    ]),
  );
}
describe("neighborhood workflows through the real local PostgreSQL API", () => {
  it("lets the owner rename their handle without changing their identity or public content", async () => {
    const f = fixture();
    const alice = await join(f);
    await join(f, "bob");
    const work = await publishedWork(f);
    const follow = await f.call("/me/follows/" + alice.id, {
      token: "fixture:bob",
      method: "PUT",
    });
    expect(follow.status).toBe(200);
    const body = {
      name: alice.name,
      bio: alice.bio,
      avatarMediaId: null,
      handle: "  Garden_Maker-1  ",
    };
    const key = crypto.randomUUID();
    const renamed = await f.call("/me", { method: "PATCH", body, key });
    expect(renamed.status, JSON.stringify(renamed.data)).toBe(200);
    expect(renamed.data).toEqual({ ...alice, handle: "garden_maker-1" });
    expect((await f.call("/me", { method: "PATCH", body, key })).data).toEqual(
      renamed.data,
    );
    expect((await f.call("/me")).data.handle).toBe("garden_maker-1");
    for (const path of ["/profiles/", "/neighbors/"]) {
      const current = await f.call(path + "garden_maker-1", { token: null });
      expect(current.status).toBe(200);
      expect((current.data.profile ?? current.data).id).toBe(alice.id);
      expect((await f.call(path + alice.handle, { token: null })).status).toBe(
        404,
      );
    }
    const feed = await f.call("/feed?owner=garden_maker-1", { token: null });
    expect(feed.data.items.map((item: any) => item.id)).toEqual([work.workId]);
    expect(
      (
        await f.call("/feed?view=following", { token: "fixture:bob" })
      ).data.items.map((item: any) => item.id),
    ).toEqual([work.workId]);
    // Older clients can still save profiles without sending a handle.
    const { handle, ...legacyBody } = body;
    expect(
      (await f.call("/me", { method: "PATCH", body: legacyBody })).data.handle,
    ).toBe("garden_maker-1");
  });
  it("rejects invalid or unauthorized handle changes without modifying the account", async () => {
    const f = fixture();
    const alice = (await f.call("/me")).data;
    const body = { name: "Changed", bio: "", avatarMediaId: null };
    for (const handle of [
      "",
      "ab",
      "a".repeat(31),
      "a b",
      "@alice",
      "a/b",
      "a.b",
      "中文名",
      null,
    ]) {
      const result = await f.call("/me", {
        method: "PATCH",
        body: { ...body, handle },
      });
      expect(result.status, String(handle)).toBe(400);
      expect(result.data.error.code).toBe("VALIDATION_ERROR");
    }
    const ag = await agent(f);
    for (const [token, status] of [
      [null, 401],
      [ag.token, 403],
    ] as const) {
      expect(
        (
          await f.call("/me", {
            token,
            method: "PATCH",
            body: { ...body, handle: "new-handle" },
          })
        ).status,
      ).toBe(status);
    }
    expect((await f.call("/me")).data).toEqual(alice);
  });
  it("returns a useful conflict for taken handles, including simultaneous case-insensitive claims", async () => {
    const f = fixture();
    const alice = (await f.call("/me")).data;
    const bob = (await f.call("/me", { token: "fixture:bob" })).data;
    const body = { name: "Renamed", bio: "", avatarMediaId: null };
    const taken = await f.call("/me", {
      method: "PATCH",
      body: { ...body, handle: bob.handle.toUpperCase() },
    });
    expect(taken.status).toBe(409);
    expect(taken.data.error.code).toBe("HANDLE_TAKEN");
    expect((await f.call("/me")).data).toEqual(alice);
    const claims = await Promise.all([
      f.call("/me", {
        method: "PATCH",
        body: { ...body, handle: "shared-home" },
      }),
      f.call("/me", {
        token: "fixture:bob",
        method: "PATCH",
        body: { ...body, handle: "SHARED-HOME" },
      }),
    ]);
    expect(claims.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(claims.find((r) => r.status === 409)?.data.error.code).toBe(
      "HANDLE_TAKEN",
    );
    const winner = claims.findIndex((r) => r.status === 200);
    const tokens = ["fixture:alice", "fixture:bob"];
    const unchanged = await f.call("/me", {
      token: tokens[winner],
      method: "PATCH",
      body: { ...body, handle: "shared-home" },
    });
    expect(unchanged.status).toBe(200);
    expect(unchanged.data.id).toBe([alice, bob][winner].id);
    expect((await f.call("/me", { token: tokens[1 - winner] })).data).toEqual(
      [alice, bob][1 - winner],
    );
  });
  it.each(
    [[], ["base"], ["robinhood"], ["base", "robinhood"]].map((historical) => ({
      historical,
    })),
  )(
    "preserves historical $historical values without exposing or filtering profiles",
    async ({ historical }) => {
      const f = fixture();
      const initial = (await f.call("/me")).data;
      await withDatabase(config.testAdminUrl, (d) =>
        d.query("UPDATE musecity.accounts SET ecosystems=$2 WHERE id=$1", [
          initial.id,
          historical,
        ]),
      );
      const alice = await join(f);
      const bob = await join(f, "bob");
      const work = await publishedWork(f);
      const post = await f.call("/posts", { method: "POST", body: update });
      expect(post.status).toBe(201);
      const reply = await f.call("/posts/" + post.data.id + "/comments", {
        token: "fixture:bob",
        method: "POST",
        body: { text: "Nice garden" },
      });
      expect(reply.status).toBe(201);
      const saved = await f.call("/me", {
        method: "PATCH",
        body: {
          name: "Garden maker",
          bio: "Making things",
          avatarMediaId: null,
          workingOn: "A garden",
          canHelp: "Design",
          handle: "garden-maker",
        },
      });
      expect(saved.status).toBe(200);
      expect(saved.data).not.toHaveProperty("ecosystems");
      expect(saved.data).toMatchObject({
        id: alice.id,
        workingOn: "A garden",
        canHelp: "Design",
        handle: "garden-maker",
      });
      expect(
        (
          await withDatabase(config.testAdminUrl, (d) =>
            d.one("SELECT ecosystems FROM musecity.accounts WHERE id=$1", [
              alice.id,
            ]),
          )
        )?.ecosystems,
      ).toEqual(historical);
      for (const token of [null, "fixture:alice"]) {
        const directory = await f.call("/neighbors?q=garden", { token });
        expect(directory.status).toBe(200);
        expect(directory.data.items.map((p: any) => p.id).sort()).toEqual(
          [alice.id, bob.id].sort(),
        );
        const feed = await f.call("/feed", { token });
        expect(feed.status).toBe(200);
        expect(feed.data.items.map((p: any) => p.id)).toEqual([
          post.data.id,
          work.workId,
        ]);
        expect(JSON.stringify([directory.data, feed.data])).not.toContain(
          '"ecosystems":',
        );
      }
      for (const path of [
        "/me",
        "/me/onboarding",
        "/profiles/garden-maker",
        "/neighbors/garden-maker",
        "/works/" + work.workId,
        "/posts/" + post.data.id,
        "/posts/" + post.data.id + "/comments",
        "/me/notifications",
      ]) {
        const result = await f.call(path);
        expect(result.status, path).toBe(200);
        expect(JSON.stringify(result.data), path).not.toContain(
          '"ecosystems":',
        );
      }
      const rejected = await f.call("/me", {
        method: "PATCH",
        body: {
          name: "Do not save",
          bio: "",
          avatarMediaId: null,
          ecosystems: historical,
        },
      });
      expect(rejected.status).toBe(400);
      expect(rejected.data.error.code).toBe("VALIDATION_ERROR");
      expect((await f.call("/me")).data.name).toBe("Garden maker");
    },
  );
  it("rejects retired REST filters even when empty or repeated", async () => {
    const f = fixture();
    await join(f);
    for (const path of ["/feed", "/neighbors"])
      for (const query of [
        "ecosystem=",
        "ecosystem=base",
        "ecosystem=robinhood",
        "ecosystem=unknown",
        "ecosystem=&ecosystem=base",
      ])
        for (const token of [null, "fixture:alice"]) {
          const result = await f.call(path + "?" + query, { token });
          expect(result.status).toBe(400);
          expect(result.data.error.code).toBe("INVALID_FILTER");
        }
  });
  it("projects historical idempotent responses without changing stored history or repeating writes", async () => {
    const f = fixture();
    const body = { name: "Alice", bio: "", avatarMediaId: null };
    const profileKey = crypto.randomUUID(),
      postKey = crypto.randomUUID();
    await f.call("/me", { method: "PATCH", body, key: profileKey });
    const post = await f.call("/posts", {
      method: "POST",
      body: update,
      key: postKey,
    });
    await withDatabase(config.testAdminUrl, async (d) => {
      await d.query(
        "UPDATE musecity.idempotency SET response=jsonb_set(response,'{ecosystems}', $2::jsonb) WHERE key=$1",
        [profileKey, '["base"]'],
      );
      await d.query(
        "UPDATE musecity.idempotency SET response=jsonb_set(response,'{owner,ecosystems}', $2::jsonb) WHERE key=$1",
        [postKey, '["robinhood"]'],
      );
    });
    expect(
      (await f.call("/me", { method: "PATCH", body, key: profileKey })).data,
    ).not.toHaveProperty("ecosystems");
    const replay = await f.call("/posts", {
      method: "POST",
      body: update,
      key: postKey,
    });
    expect(replay.data.id).toBe(post.data.id);
    expect(replay.data.owner).not.toHaveProperty("ecosystems");
    expect((await f.call("/feed")).data.items).toHaveLength(1);
    const snapshots = await withDatabase(config.testAdminUrl, (d) =>
      d.query<{ response: any }>(
        "SELECT response FROM musecity.idempotency WHERE key=ANY($1)",
        [[profileKey, postKey]],
      ),
    );
    for (const snapshot of snapshots)
      expect(JSON.stringify(snapshot.response)).toContain('"ecosystems":');
  });
  it("keeps legacy accounts and agents private from the directory until the owner opts in", async () => {
    const f = fixture();
    const old = (await f.call("/me")).data;
    const ag = await agent(f);
    expect(
      (await f.call("/neighbors", { token: null })).data.items,
    ).toHaveLength(0);
    expect(
      (await f.call("/neighbors/" + old.handle, { token: null })).data.agents,
    ).toEqual([]);
    const alice = await join(f, "alice");
    expect(
      (await f.call("/neighbors?q=garden", { token: null })).data.items.map(
        (v: any) => v.id,
      ),
    ).toEqual([alice.id]);
    expect((await f.call("/neighbors/" + alice.handle)).data.agents).toEqual(
      [],
    );
    expect(
      (
        await f.call("/me/agents/" + ag.id, {
          method: "PATCH",
          token: ag.token,
          body: { confirmed: true, publicVisible: true },
        })
      ).status,
    ).toBe(403);
    await f.call("/me/agents/" + ag.id, {
      method: "PATCH",
      body: {
        confirmed: true,
        publicVisible: true,
        description: "I help with research.",
      },
    });
    const profile = (
      await f.call("/neighbors/" + alice.handle, { token: null })
    ).data;
    expect(profile.agents).toEqual([
      {
        id: ag.id,
        name: "Garden assistant",
        description: "I help with research.",
        muse: null,
      },
    ]);
    for (const forbidden of [
      "scopes",
      "credential",
      "lastActiveAt",
      "privy_user_id",
    ])
      expect(JSON.stringify(profile)).not.toContain(forbidden);
    expect(
      (
        await f.call("/me", {
          method: "PATCH",
          body: { ...alice, role: "moderator" },
        })
      ).status,
    ).toBe(400);
    await f.call("/me/agents/" + ag.id + "/revoke", {
      method: "POST",
      body: { confirmed: true },
    });
    expect((await f.call("/neighbors/" + alice.handle)).data.agents).toEqual(
      [],
    );
  });
  it("accepts undeclared and non-AI works and keeps mixed feed order stable across revisions and republication", async () => {
    const f = fixture();
    await join(f);
    const work = await publishedWork(f);
    expect(work.body).not.toHaveProperty("aiDeclaration");
    const first = await f.call("/feed", { token: null });
    expect(first.status, JSON.stringify(first.data)).toBe(200);
    const time = first.data.items[0].createdAt;
    const post = await f.call("/posts", { method: "POST", body: update });
    expect(post.status, JSON.stringify(post.data)).toBe(201);
    const revision = await f.call("/works/" + work.workId, {
      method: "PATCH",
      body: {
        baseRevisionId: work.revisionId,
        content: {
          ...article,
          aiDeclaration: false,
          title: "A handmade garden",
        },
      },
    });
    await f.call("/works/" + work.workId + "/publish", {
      method: "POST",
      body: { revisionId: revision.data.revisionId },
    });
    let mixed = (await f.call("/feed", { token: null })).data.items;
    expect(mixed.map((v: any) => v.id)).toEqual([post.data.id, work.workId]);
    expect(mixed[1].createdAt).toBe(time);
    expect(mixed[1].work.body.aiDeclaration).toBe(false);
    expect(
      (await f.call("/feed?type=article", { token: null })).data.items.map(
        (v: any) => v.id,
      ),
    ).toEqual([work.workId]);
    await f.call("/works/" + work.workId + "/unpublish", {
      method: "POST",
      body: { revisionId: revision.data.revisionId },
    });
    expect((await f.call("/feed", { token: null })).data.items).toHaveLength(1);
    await f.call("/works/" + work.workId + "/publish", {
      method: "POST",
      body: { revisionId: revision.data.revisionId },
    });
    mixed = (await f.call("/feed", { token: null })).data.items;
    expect(mixed[1].createdAt).toBe(time);
  });
  it("follows households, includes their agents, sends private notifications and respects account isolation", async () => {
    const f = fixture();
    const alice = await join(f);
    await join(f, "bob");
    const ag = await agent(f, [...draftScopes, "community:post"]);
    const post = await f.call("/posts", {
      token: ag.token,
      method: "POST",
      body: update,
    });
    expect(post.status).toBe(201);
    expect(post.data.owner.id).toBe(alice.id);
    expect(post.data.agent.id).toBe(ag.id);
    expect((await f.call("/feed?view=following", { token: null })).status).toBe(
      401,
    );
    expect(
      (await f.call("/feed?view=following", { token: "fixture:bob" })).data
        .items,
    ).toHaveLength(0);
    const options = { token: "fixture:bob", method: "PUT" };
    await f.call("/me/follows/" + alice.id, options);
    await f.call("/me/follows/" + alice.id, options);
    expect(
      (await f.call("/feed?view=following", { token: "fixture:bob" })).data
        .items[0].post.agent.id,
    ).toBe(ag.id);
    let notices = (await f.call("/me/notifications")).data;
    expect(notices.unread).toBe(1);
    await f.call("/me/notifications/read", {
      token: "fixture:bob",
      method: "POST",
      body: { ids: [notices.items[0].id] },
    });
    expect((await f.call("/me/notifications")).data.unread).toBe(1);
    await f.call("/me/notifications/read", {
      method: "POST",
      body: { ids: [notices.items[0].id] },
    });
    expect((await f.call("/me/notifications")).data.unread).toBe(0);
    for (const path of [
      "/me/notifications",
      "/me/blocks",
      "/me/relationships/" + alice.id,
    ])
      expect((await f.call(path, { token: ag.token })).status).toBe(403);
  });
  it("supports update replies on both content types, safe text and optimistic edits", async () => {
    const f = fixture();
    await join(f);
    await join(f, "bob");
    const post = (
      await f.call("/posts", { method: "POST", body: gardenUpdate })
    ).data;
    const reply = await f.call("/posts/" + post.id + "/comments", {
      token: "fixture:bob",
      method: "POST",
      body: { text: "I can help <script>alert(1)</script>" },
    });
    expect(reply.status).toBe(201);
    const second = await f.call("/posts/" + post.id + "/comments", {
      method: "POST",
      body: { text: "Thank you", parentId: reply.data.id },
    });
    expect(second.status).toBe(201);
    expect((await f.call("/me/notifications")).data.items[0].kind).toBe(
      "comment",
    );
    expect(
      (await f.call("/me/notifications", { token: "fixture:bob" })).data
        .items[0].kind,
    ).toBe("reply");
    expect(
      (
        await f.call("/posts/" + post.id, {
          method: "PATCH",
          body: {
            revision: 1,
            content: { ...gardenUpdate, text: "Public revised update" },
          },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await f.call("/posts/" + post.id, {
          method: "PATCH",
          body: { revision: 1, content: gardenUpdate },
        })
      ).status,
    ).toBe(409);
    const work = await publishedWork(f);
    expect(
      (
        await f.call("/works/" + work.workId + "/comments", {
          token: "fixture:bob",
          method: "POST",
          body: { text: "Looks great", parentId: reply.data.id },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await f.call("/works/" + work.workId + "/comments", {
          token: "fixture:bob",
          method: "POST",
          body: { text: "Looks great" },
        })
      ).status,
    ).toBe(201);
    await f.call("/comments/" + reply.data.id, {
      token: "fixture:bob",
      method: "DELETE",
    });
    const comments = (await f.call("/posts/" + post.id + "/comments")).data
      .items;
    expect(comments[0].deleted).toBe(true);
    expect(comments[0].text).toBe("");
    expect(comments[1].text).toBe("Thank you");
  });
  it("does not expand old credentials and applies pause, downgrade, rotation and revoke before replay", async () => {
    const f = fixture();
    const ag = await agent(f, publishScopes);
    const key = "community-publication-key";
    const options = { token: ag.token, method: "POST", body: update, key };
    expect((await f.call("/posts", options)).status).toBe(403);
    await f.call("/me/agents/" + ag.id, {
      method: "PATCH",
      body: {
        confirmed: true,
        scopes: [...publishScopes, "community:post", "community:reply"],
      },
    });
    const post = await f.call("/posts", options);
    expect(post.status).toBe(201);
    expect(
      (
        await f.call("/posts", {
          ...options,
          key: "forged-owner",
          body: { ...update, ownerAccountId: "bob" },
        })
      ).status,
    ).toBe(400);
    const peer = await agent(f, [...draftScopes, "community:post"]);
    expect(
      (
        await f.call("/posts/" + post.data.id, {
          token: peer.token,
          method: "PATCH",
          body: { revision: 1, content: update },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await f.call("/posts/" + post.data.id, {
          token: ag.token,
          method: "DELETE",
          body: { revision: 1 },
        })
      ).status,
    ).toBe(403);
    await f.call("/me/agents/" + ag.id + "/pause", {
      method: "POST",
      body: { confirmed: true },
    });
    expect((await f.call("/posts", options)).status).toBe(403);
    await f.call("/me/agents/" + ag.id + "/resume", {
      method: "POST",
      body: { confirmed: true },
    });
    await f.call("/me/agents/" + ag.id, {
      method: "PATCH",
      body: { confirmed: true, scopes: publishScopes },
    });
    expect((await f.call("/posts", options)).status).toBe(403);
    const rotated = await f.call(
      "/me/agents/" + ag.id + "/credentials/rotate",
      { method: "POST", body: { confirmed: true } },
    );
    expect((await f.call("/posts", options)).status).toBe(401);
    await f.call("/me/agents/" + ag.id + "/revoke", {
      method: "POST",
      body: { confirmed: true },
    });
    expect(
      (
        await f.call("/posts", {
          ...options,
          token: rotated.data.credential.token,
        })
      ).status,
    ).toBe(401);
  });
  it("orders blocking against replies, excludes households and prevents further interaction", async () => {
    const f = fixture();
    const alice = await join(f),
      bob = await join(f, "bob");
    const ag = await agent(f, [...draftScopes, "community:reply"]);
    const post = (
      await f.call("/posts", {
        token: "fixture:bob",
        method: "POST",
        body: update,
      })
    ).data;
    const [blocked, reply] = await Promise.all([
      f.call("/me/blocks/" + alice.id, { token: "fixture:bob", method: "PUT" }),
      f.call("/posts/" + post.id + "/comments", {
        token: ag.token,
        method: "POST",
        body: { text: "Hello" },
      }),
    ]);
    expect(blocked.status).toBe(200);
    expect([201, 404]).toContain(reply.status);
    expect(
      (
        await f.call("/posts/" + post.id + "/comments", {
          token: ag.token,
          method: "POST",
          body: { text: "Again" },
        })
      ).status,
    ).toBe(404);
    expect(
      (await f.call("/me/follows/" + bob.id, { method: "PUT" })).status,
    ).toBe(404);
    expect((await f.call("/feed")).data.items).toEqual([]);
    expect(
      (await f.call("/neighbors")).data.items.map((v: any) => v.id),
    ).toEqual([alice.id]);
    expect(
      (await f.call("/me/notifications", { token: "fixture:bob" })).data.items,
    ).toEqual([]);
    await f.call("/me/blocks/" + alice.id, {
      token: "fixture:bob",
      method: "DELETE",
    });
    expect(
      (
        await f.call("/posts/" + post.id + "/comments", {
          token: ag.token,
          method: "POST",
          body: { text: "Now allowed" },
        })
      ).status,
    ).toBe(201);
  });
  it("orders work withdrawal against incoming replies without deadlocks or hidden-target notifications", async () => {
    const f = fixture();
    const work = await publishedWork(f);
    const outcomes = await Promise.all([
      f.call("/works/" + work.workId + "/unpublish", {
        method: "POST",
        body: { revisionId: work.revisionId },
      }),
      f.call("/works/" + work.workId + "/comments", {
        token: "fixture:bob",
        method: "POST",
        body: { text: "A concurrent reply" },
      }),
    ]);
    expect(outcomes[0]!.status).toBe(200);
    expect([201, 404]).toContain(outcomes[1]!.status);
    expect((await f.call("/me/notifications")).data.items).toEqual([]);
    expect(
      (await f.call("/works/" + work.workId + "/comments", { token: null }))
        .status,
    ).toBe(404);
  });
  it("shares quotas across owner, works and multiple agents; retries do not count twice", async () => {
    const f = fixture();
    const alice = await join(f);
    const ag = await agent(f, [
      ...draftScopes,
      "community:post",
      "community:reply",
    ]);
    for (let i = 0; i < 18; i++)
      expect(
        (
          await f.call("/posts", {
            token: i % 2 ? ag.token : "fixture:alice",
            method: "POST",
            body: { ...update, text: "Post " + i },
          })
        ).status,
      ).toBe(201);
    await publishedWork(f);
    const options = {
      method: "POST",
      body: update,
      key: "quota-idempotent-post",
    };
    expect((await f.call("/posts", options)).status).toBe(201);
    expect((await f.call("/posts", options)).status).toBe(201);
    expect(
      (
        await f.call("/posts", {
          token: ag.token,
          method: "POST",
          body: update,
        })
      ).status,
    ).toBe(429);
    const post = (await f.call("/feed?kind=update")).data.items[0].id;
    await withDatabase(config.testAdminUrl, (d) =>
      d.query(
        "INSERT INTO musecity.rate_limits(key,counter,expires_at) VALUES($1,99,now()+interval '1 day')",
        [
          `community:${alice.id}:reply:${new Date().toISOString().slice(0, 10)}`,
        ],
      ),
    );
    const reply = {
      token: ag.token,
      method: "POST",
      body: { text: "Last reply" },
      key: "quota-idempotent-reply",
    };
    expect((await f.call("/posts/" + post + "/comments", reply)).status).toBe(
      201,
    );
    expect((await f.call("/posts/" + post + "/comments", reply)).status).toBe(
      201,
    );
    expect(
      (
        await f.call("/posts/" + post + "/comments", {
          method: "POST",
          body: { text: "One too many" },
        })
      ).status,
    ).toBe(429);
  });
  it("serializes the final publication slot and paginates replies and private notifications without duplicates", async () => {
    const f = fixture();
    const alice = await join(f);
    const ag = await agent(f, [
      ...draftScopes,
      "community:post",
      "community:reply",
    ]);
    await withDatabase(config.testAdminUrl, (d) =>
      d.query(
        "INSERT INTO musecity.rate_limits(key,counter,expires_at) VALUES($1,19,now()+interval '1 day')",
        [
          `community:${alice.id}:publication:${new Date().toISOString().slice(0, 10)}`,
        ],
      ),
    );
    const writes = await Promise.all([
      f.call("/posts", { method: "POST", body: update }),
      f.call("/posts", { method: "POST", body: update, token: ag.token }),
    ]);
    expect(writes.map((r) => r.status).sort()).toEqual([201, 429]);
    const post = writes.find((r) => r.status === 201)!.data;
    for (let i = 0; i < 23; i++)
      expect(
        (
          await f.call("/posts/" + post.id + "/comments", {
            token: "fixture:bob",
            method: "POST",
            body: { text: "Comment " + i },
          })
        ).status,
      ).toBe(201);
    const first = (await f.call("/posts/" + post.id + "/comments")).data;
    const next = (
      await f.call(
        "/posts/" +
          post.id +
          "/comments?cursor=" +
          encodeURIComponent(first.nextCursor),
      )
    ).data;
    expect(first.items).toHaveLength(20);
    expect(next.items).toHaveLength(3);
    expect(new Set([...first.items, ...next.items].map((c) => c.id)).size).toBe(
      23,
    );
    const notices = (await f.call("/me/notifications")).data;
    const more = (
      await f.call(
        "/me/notifications?cursor=" + encodeURIComponent(notices.nextCursor),
      )
    ).data;
    expect(notices.unread).toBe(23);
    expect(
      new Set([...notices.items, ...more.items].map((n) => n.id)).size,
    ).toBe(23);
    expect(
      (
        await f.call(
          "/me/notifications?cursor=" + encodeURIComponent(notices.nextCursor),
          { token: "fixture:bob" },
        )
      ).status,
    ).toBe(400);
    await f.call("/me/notifications/read", {
      method: "POST",
      body: { ids: notices.items.map((n: { id: string }) => n.id) },
    });
    expect((await f.call("/me/notifications")).data.unread).toBe(3);
  });
  it("paginates mixed content without omissions, rejects mismatched cursors and validates filters", async () => {
    const f = fixture();
    await join(f);
    await join(f, "bob");
    for (let i = 0; i < 25; i++)
      expect(
        (
          await f.call("/posts", {
            token: i % 2 ? "fixture:bob" : "fixture:alice",
            method: "POST",
            body: i % 3 ? update : gardenUpdate,
          })
        ).status,
      ).toBe(201);
    await publishedWork(f);
    const first = await f.call("/feed", { token: null });
    expect(first.status).toBe(200);
    expect(first.data.items).toHaveLength(20);
    const old = JSON.parse(atob(first.data.nextCursor));
    const filters = JSON.parse(old.filter);
    filters.unshift(null);
    old.filter = JSON.stringify(filters);
    const retired = await f.call(
      "/feed?cursor=" + encodeURIComponent(btoa(JSON.stringify(old))),
      { token: null },
    );
    expect(retired.status).toBe(400);
    expect(retired.data.error.code).toBe("INVALID_CURSOR");
    const next = await f.call(
      "/feed?cursor=" + encodeURIComponent(first.data.nextCursor),
      { token: null },
    );
    expect(next.data.items).toHaveLength(6);
    expect(
      new Set([...first.data.items, ...next.data.items].map((v: any) => v.id))
        .size,
    ).toBe(26);
    expect(
      (
        await f.call(
          "/feed?kind=update&cursor=" +
            encodeURIComponent(first.data.nextCursor),
          { token: null },
        )
      ).status,
    ).toBe(400);
    for (const query of [
      "ecosystem=unknown",
      "kind=unknown",
      "view=unknown",
      "cursor=nope",
      "tag=unknown",
    ])
      expect((await f.call("/feed?" + query, { token: null })).status).toBe(
        400,
      );
  });
  it("paginates a Unicode neighbor search without losing tied timestamps", async () => {
    const f = fixture();
    await withDatabase(config.testAdminUrl, (d) =>
      d.query(
        "INSERT INTO musecity.accounts(id,privy_user_id,handle,name,joined_at) SELECT 'neighbor-'||i,'fixture-neighbor-'||i,'neighbor-'||i,'Neighbor 🌱 '||i,date_trunc('milliseconds',now()) FROM generate_series(1,23) i",
      ),
    );
    const first = await f.call(
      "/neighbors?q=" + encodeURIComponent("Neighbor 🌱"),
      {
        token: null,
      },
    );
    expect(first.status, JSON.stringify(first.data)).toBe(200);
    expect(first.data.items).toHaveLength(20);
    const old = JSON.parse(
      Buffer.from(first.data.nextCursor, "base64").toString("utf8"),
    );
    const filters = JSON.parse(old.filter);
    filters.splice(2, 0, null);
    old.filter = JSON.stringify(filters);
    const retired = await f.call(
      "/neighbors?q=" +
        encodeURIComponent("Neighbor 🌱") +
        "&cursor=" +
        encodeURIComponent(Buffer.from(JSON.stringify(old)).toString("base64")),
      { token: null },
    );
    expect(retired.status).toBe(400);
    expect(retired.data.error.code).toBe("INVALID_CURSOR");
    const more = await f.call(
      "/neighbors?q=" +
        encodeURIComponent("Neighbor 🌱") +
        "&cursor=" +
        encodeURIComponent(first.data.nextCursor),
      { token: null },
    );
    expect(more.status).toBe(200);
    expect(
      new Set([...first.data.items, ...more.data.items].map((n: any) => n.id))
        .size,
    ).toBe(23);
  });
  it("requires operator membership, hides reported content and related comments/notices, and permits audited restoration", async () => {
    const f = fixture();
    const alice = await join(f);
    await join(f, "bob");
    const post = (
      await f.call("/posts", { method: "POST", body: gardenUpdate })
    ).data;
    const c = await f.call("/posts/" + post.id + "/comments", {
      token: "fixture:bob",
      method: "POST",
      body: { text: "I can help" },
    });
    const report = await f.call("/reports", {
      token: "fixture:bob",
      method: "POST",
      body: {
        targetKind: "post",
        targetId: post.id,
        reason: "Please review this request.",
      },
    });
    expect(report.status).toBe(201);
    expect((await f.call("/moderation/reports")).status).toBe(403);
    await makeModerator(alice.id);
    expect((await f.call("/moderation/reports")).data.items[0].id).toBe(
      report.data.id,
    );
    expect(
      (
        await f.call("/moderation/reports/" + report.data.id, {
          token: "fixture:bob",
          method: "POST",
          body: { action: "hide", confirmed: true },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await f.call("/moderation/reports/" + report.data.id, {
          method: "POST",
          body: { action: "hide", confirmed: true },
        })
      ).status,
    ).toBe(200);
    for (const path of ["/posts/" + post.id, "/posts/" + post.id + "/comments"])
      expect((await f.call(path, { token: null })).status).toBe(404);
    expect((await f.call("/feed")).data.items).toEqual([]);
    expect((await f.call("/me/notifications")).data.items).toEqual([]);
    expect(
      (
        await f.call("/posts/" + post.id, {
          method: "PATCH",
          body: { revision: 1, content: gardenUpdate },
        })
      ).status,
    ).toBe(423);
    await f.call("/moderation/reports/" + report.data.id, {
      method: "POST",
      body: { action: "restore", confirmed: true },
    });
    expect((await f.call("/posts/" + post.id)).status).toBe(200);
    expect(
      (await f.call("/posts/" + post.id + "/comments")).data.items[0].id,
    ).toBe(c.data.id);
    await expect(
      withDatabase(config.testUrl, (d) =>
        d.query("INSERT INTO musecity.moderators(account_id) VALUES($1)", [
          alice.id,
        ]),
      ),
    ).rejects.toThrow();
  });
  it("hides an entire reported household and blocks its agents until an operator restores it", async () => {
    const f = fixture();
    const alice = await join(f),
      bob = await join(f, "bob");
    const ag = await agent(f, [
      ...publishScopes,
      "community:post",
      "community:reply",
    ]);
    await f.call("/me/agents/" + ag.id, {
      method: "PATCH",
      body: { publicVisible: true, confirmed: true },
    });
    const post = (
      await f.call("/posts", { method: "POST", body: update, token: ag.token })
    ).data;
    await publishedWork(f);
    await makeModerator(bob.id);
    const report = (
      await f.call("/reports", {
        method: "POST",
        token: "fixture:bob",
        body: {
          targetKind: "account",
          targetId: alice.id,
          reason: "Household moderation test.",
        },
      })
    ).data;
    expect(
      (
        await f.call("/moderation/reports/" + report.id, {
          method: "POST",
          token: "fixture:bob",
          body: { action: "hide", confirmed: true },
        })
      ).status,
    ).toBe(200);
    expect((await f.call("/feed", { token: null })).data.items).toEqual([]);
    expect((await f.call("/works", { token: null })).data.items).toEqual([]);
    expect(
      (await f.call("/neighbors/" + alice.handle, { token: null })).status,
    ).toBe(404);
    expect((await f.call("/posts/" + post.id, { token: null })).status).toBe(
      404,
    );
    expect(
      (
        await f.call("/posts", {
          method: "POST",
          token: ag.token,
          body: update,
        })
      ).status,
    ).toBe(403);
    await f.call("/moderation/reports/" + report.id, {
      method: "POST",
      token: "fixture:bob",
      body: { action: "restore", confirmed: true },
    });
    expect((await f.call("/feed", { token: null })).data.items).toHaveLength(2);
    expect(
      (
        await f.call("/posts", {
          method: "POST",
          token: ag.token,
          body: update,
        })
      ).status,
    ).toBe(201);
  });
  it("protects post images until ready and removes public access after deletion or moderation", async () => {
    const f = fixture();
    const bytes = Uint8Array.from(
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4z8DQAAAEgQGADgLFJAAAAABJRU5ErkJggg==",
        "base64",
      ),
    );
    const up = (
      await f.call("/media/uploads", {
        method: "POST",
        body: { mimeType: "image/png", byteSize: bytes.length },
      })
    ).data;
    expect(
      (
        await f.call("/posts", {
          method: "POST",
          body: { ...update, mediaIds: [up.mediaId] },
        })
      ).status,
    ).toBe(409);
    await f.app.request("http://localhost" + up.uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "image/png",
        "X-Upload-Token": up.uploadToken,
      },
      body: bytes,
    });
    await f.call("/media/" + up.mediaId + "/complete", {
      method: "POST",
      body: {},
    });
    expect(
      (
        await f.call("/posts", {
          token: "fixture:bob",
          method: "POST",
          body: { ...update, mediaIds: [up.mediaId] },
        })
      ).status,
    ).toBe(404);
    expect(
      (await f.call("/raw-media/" + up.mediaId, { token: null })).status,
    ).toBe(404);
    const post = (
      await f.call("/posts", {
        method: "POST",
        body: { ...update, mediaIds: [up.mediaId] },
      })
    ).data;
    expect(
      (await f.call("/raw-media/" + up.mediaId, { token: null })).status,
    ).toBe(200);
    const bob = await join(f, "bob");
    await makeModerator(bob.id);
    const report = (
      await f.call("/reports", {
        token: "fixture:bob",
        method: "POST",
        body: {
          targetKind: "post",
          targetId: post.id,
          reason: "Review this image post.",
        },
      })
    ).data;
    await f.call("/moderation/reports/" + report.id, {
      token: "fixture:bob",
      method: "POST",
      body: { action: "hide", confirmed: true },
    });
    expect(
      (await f.call("/raw-media/" + up.mediaId, { token: null })).status,
    ).toBe(404);
    await f.call("/moderation/reports/" + report.id, {
      token: "fixture:bob",
      method: "POST",
      body: { action: "restore", confirmed: true },
    });
    expect(
      (await f.call("/raw-media/" + up.mediaId, { token: null })).status,
    ).toBe(200);
    await f.call("/posts/" + post.id, {
      method: "DELETE",
      body: { revision: post.revision },
    });
    expect(
      (await f.call("/raw-media/" + up.mediaId, { token: null })).status,
    ).toBe(404);
  });
});

describe("unified private content management", () => {
  it("finds human and Agent content, preserves private revisions, and enforces owner-only access", async () => {
    const f = fixture();
    const alice = (await f.call("/me")).data;
    const ag = await agent(f, [...publishScopes, "community:post"]);
    const work = await publishedWork(f, ag.token);
    const revision = await f.call(`/works/${work.workId}`, {
      method: "PATCH",
      token: ag.token,
      body: {
        baseRevisionId: work.revisionId,
        content: { ...article, title: "Private revised title" },
      },
    });
    expect(revision.status).toBe(200);
    const updatePost = (
      await f.call("/posts", { method: "POST", body: update })
    ).data;
    const agentPost = (
      await f.call("/posts", {
        token: ag.token,
        method: "POST",
        body: gardenUpdate,
      })
    ).data;
    const list = await f.call("/me/content");
    expect(list.status).toBe(200);
    expect(list.response.headers.get("cache-control")).toContain("no-store");
    expect(list.data.items.map((i: any) => i.id)).toEqual([
      agentPost.id,
      updatePost.id,
      work.workId,
    ]);
    expect(list.data.items[0]).toMatchObject({
      kind: "update",
      agent: { id: ag.id },
      restricted: false,
    });
    expect(list.data.items[1]).toMatchObject({ kind: "update", agent: null });
    expect(list.data.items[2]).toMatchObject({
      title: "Private revised title",
      pendingChanges: true,
      agent: { id: ag.id },
      revisionId: revision.data.revisionId,
      publishedRevisionId: work.revisionId,
    });
    expect(
      (await f.call(`/works/${work.workId}`, { token: null })).data.body.title,
    ).toBe(article.title);
    expect(
      (
        await f.call("/feed?owner=" + alice.handle, { token: null })
      ).data.items.find((i: any) => i.id === work.workId).work.body.title,
    ).toBe(article.title);
    expect((await f.call("/me/content", { token: null })).status).toBe(401);
    expect((await f.call("/me/content", { token: ag.token })).status).toBe(403);
    expect(
      (await f.call("/me/content", { token: "fixture:bob" })).data.items,
    ).toEqual([]);
    expect(
      (await f.call("/me/content?owner=" + alice.id, { token: "fixture:bob" }))
        .status,
    ).toBe(400);
    expect(
      (
        await f.call(`/works/${work.workId}?draft=true`, {
          token: "fixture:bob",
        })
      ).status,
    ).toBe(404);
    const edited = await f.call(`/posts/${updatePost.id}`, {
      method: "PATCH",
      body: {
        revision: updatePost.revision,
        content: { ...update, text: "Public update edited" },
      },
    });
    expect(edited.status).toBe(200);
    expect(
      (await f.call(`/posts/${updatePost.id}`, { token: null })).data.text,
    ).toBe("Public update edited");
    expect(
      (
        await f.call(`/works/${work.workId}/unpublish`, {
          method: "POST",
          body: { revisionId: revision.data.revisionId },
        })
      ).status,
    ).toBe(200);
    expect(
      (await f.call("/me/content?kind=work&status=unpublished&type=article"))
        .data.items[0].id,
    ).toBe(work.workId);
    expect(
      (await f.call(`/works/${work.workId}`, { token: null })).status,
    ).toBe(404);
    for (const path of [
      `/works/${work.workId}`,
      `/posts/${updatePost.id}`,
      `/posts/${agentPost.id}`,
    ]) {
      const current = path.includes("posts") ? (await f.call(path)).data : null;
      expect(
        (
          await f.call(path, {
            method: "DELETE",
            body: current ? { revision: current.revision } : undefined,
          })
        ).status,
      ).toBe(200);
    }
    expect((await f.call("/me/content")).data.items).toEqual([]);
  });

  it("paginates a mixed list at tied timestamps without duplicates or omissions and binds cursors to filters and owner", async () => {
    const f = fixture();
    const alice = (await f.call("/me")).data;
    const expected = [];
    for (let i = 0; i < 26; i++) {
      const result =
        i % 2 === 0
          ? await f.call("/works", {
              method: "POST",
              body: { ...article, title: `Draft ${i}` },
            })
          : await f.call("/posts", {
              method: "POST",
              body: i % 3 ? update : gardenUpdate,
            });
      expect(result.status, JSON.stringify(result.data)).toBe(201);
      expected.push(result.data.workId ?? result.data.id);
    }
    await withDatabase(config.testAdminUrl, async (db) => {
      for (const table of ["works", "posts"])
        await db.query(
          `UPDATE musecity.${table} SET updated_at='2026-09-22T00:00:00.000Z' WHERE owner_account_id=$1`,
          [alice.id],
        );
    });
    const first = (await f.call("/me/content")).data;
    expect(first.items).toHaveLength(20);
    const second = (
      await f.call("/me/content?cursor=" + encodeURIComponent(first.nextCursor))
    ).data;
    expect(second.items).toHaveLength(6);
    expect(second.nextCursor).toBeNull();
    const ids = [...first.items, ...second.items].map((i: any) => i.id);
    expect(new Set(ids).size).toBe(26);
    expect(ids).toEqual(expected.sort().reverse());
    expect(
      (
        await f.call(
          "/me/content?kind=work&cursor=" +
            encodeURIComponent(first.nextCursor),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await f.call(
          "/me/content?cursor=" + encodeURIComponent(first.nextCursor),
          { token: "fixture:bob" },
        )
      ).status,
    ).toBe(400);
    expect(
      (await f.call("/me/content?kind=work&status=draft")).data.items,
    ).toHaveLength(13);
    expect(
      (await f.call("/me/content?kind=update")).data.items.every(
        (i: any) => i.kind === "update",
      ),
    ).toBe(true);
    for (const filter of [
      "kind=update&status=draft",
      "kind=work&help=open",
      "kind=help&type=article",
      "kind=wrong",
      "cursor=garbage",
    ])
      expect((await f.call("/me/content?" + filter)).status).toBe(400);
    expect(
      (await f.call("/feed", { token: null })).data.items.every(
        (i: any) => i.kind !== "work",
      ),
    ).toBe(true);
  });

  it("keeps moderation restrictions visible privately and prevents publishing or editing around them", async () => {
    const f = fixture(),
      work = await publishedWork(f);
    const post = (
      await f.call("/posts", { method: "POST", body: gardenUpdate })
    ).data;
    await withDatabase(config.testAdminUrl, async (db) => {
      await db.query("UPDATE musecity.works SET blocked=true WHERE id=$1", [
        work.workId,
      ]);
      await db.query("UPDATE musecity.posts SET blocked=true WHERE id=$1", [
        post.id,
      ]);
    });
    const list = (await f.call("/me/content")).data;
    expect(list.items).toHaveLength(2);
    expect(list.items.every((i: any) => i.restricted)).toBe(true);
    expect(
      (await f.call(`/works/${work.workId}?draft=true`)).data.restricted,
    ).toBe(true);
    expect((await f.call("/feed", { token: null })).data.items).toEqual([]);
    expect(
      (
        await f.call(`/works/${work.workId}/publish`, {
          method: "POST",
          body: { revisionId: work.revisionId },
        })
      ).status,
    ).toBe(423);
    expect(
      (
        await f.call(`/works/${work.workId}`, {
          method: "PATCH",
          body: { baseRevisionId: work.revisionId, content: article },
        })
      ).status,
    ).toBe(423);
    expect(
      (
        await f.call(`/posts/${post.id}`, {
          method: "PATCH",
          body: { revision: post.revision, content: gardenUpdate },
        })
      ).status,
    ).toBe(423);
  });
});
