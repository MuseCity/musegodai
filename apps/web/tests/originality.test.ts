import { beforeEach, describe, expect, it, vi } from "vitest";
import { config, fixture, reset } from "./helpers";
import { withDatabase } from "../src/server/database";
import { draftScopes, publishScopes } from "../src/shared/contracts";
import {
  failedWebsiteCheck,
  type WebsiteInput,
  type WebsiteResult,
} from "../src/server/website-verification";
import { assertLocalTarget } from "../scripts/local-target";
beforeEach(reset);
async function admin(query: string, values: unknown[] = []) {
  assertLocalTarget(config.testAdminUrl, "musecity_test", "musecity_admin");
  return withDatabase(config.testAdminUrl, (d) => d.query(query, values));
}
async function activate(f: ReturnType<typeof fixture>, scopes = publishScopes) {
  const invitation = await f.call("/me/agent-invitations", {
    method: "POST",
    body: { name: "Website Muse", scopes, confirmed: true },
  });
  const registration = await f.call("/agent-registrations", {
    token: null,
    method: "POST",
    body: {
      name: "Website Muse",
      requestedScopes: scopes,
      invitationToken: invitation.data.invitationToken,
    },
  });
  const result = await f.call(
    "/agent-registrations/" + registration.data.registrationId + "/activate",
    { method: "POST", token: registration.data.registrationToken },
  );
  expect(result.status).toBe(201);
  return { id: result.data.agentId, token: result.data.credential.token };
}
async function cover(f: ReturnType<typeof fixture>, token = "fixture:alice") {
  const bytes = Uint8Array.from(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4z8DQAAAEgQGADgLFJAAAAABJRU5ErkJggg==",
      "base64",
    ),
  );
  const upload = await f.call("/media/uploads", {
    token,
    method: "POST",
    body: { mimeType: "image/png", byteSize: bytes.length },
  });
  expect(upload.status).toBe(201);
  expect(
    (
      await f.app.request("http://localhost" + upload.data.uploadUrl, {
        method: "PUT",
        body: bytes,
        headers: {
          "Content-Type": "image/png",
          "X-Upload-Token": upload.data.uploadToken,
        },
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await f.call("/media/" + upload.data.mediaId + "/complete", {
        token,
        method: "POST",
        body: {},
      })
    ).status,
  ).toBe(200);
  return upload.data.mediaId;
}
async function draft(f: ReturnType<typeof fixture>, token = "fixture:alice") {
  const result = await f.call("/works", {
    token,
    method: "POST",
    body: {
      type: "website",
      title: "Original garden",
      description: "A website I created",
      websiteUrl: "https://creator.example.com/garden",
      coverMediaId: await cover(f, token),
      aiDeclaration: true,
      aiTools: ["Codex Sites"],
      tagIds: ["design"],
    },
  });
  expect(result.status).toBe(201);
  return result.data;
}
function success(input: WebsiteInput): WebsiteResult {
  const { marker: _, ...subject } = input.subjects[0];
  return {
    status: "verified",
    reason: null,
    subject,
    finalUrl: input.url,
    checkedAt: new Date().toISOString(),
  };
}
function gates() {
  let enter!: () => void, release!: () => void;
  return {
    entered: new Promise<void>((resolve) => {
      enter = resolve;
    }),
    wait: new Promise<void>((resolve) => {
      release = resolve;
    }),
    enter: () => enter(),
    release: () => release(),
  };
}
const path = (work: any, action: string) =>
  "/works/" + work.workId + "/" + action;
const body = (work: any) => ({ revisionId: work.revisionId });

describe("website originality through real local PostgreSQL with injected webpage results", () => {
  it("keeps public markers stable and separate from public profiles and credentials", async () => {
    const f = fixture(),
      me = (await f.call("/me")).data;
    expect(me.websiteMarker).toMatch(/^mc_u_[a-f0-9-]{36}$/);
    expect(
      (await f.call("/me", { token: "fixture:bob" })).data.websiteMarker,
    ).not.toBe(me.websiteMarker);
    await f.call("/me", {
      method: "PATCH",
      body: {
        name: "Renamed",
        handle: "renamed",
        bio: "",
        avatarMediaId: null,
        join: true,
      },
    });
    expect((await f.call("/me")).data.websiteMarker).toBe(me.websiteMarker);
    expect(
      (await f.call("/neighbors/renamed", { token: null })).data,
    ).not.toHaveProperty("websiteMarker");
    const ag = await activate(f);
    const identity = (await f.call("/agent", { token: ag.token })).data;
    expect(identity.websiteMarker).toMatch(/^mc_a_[a-f0-9-]{36}$/);
    expect(identity.owner).not.toHaveProperty("websiteMarker");
    const rotated = await f.call(
      "/me/agents/" + ag.id + "/credentials/rotate",
      { method: "POST", body: { confirmed: true } },
    );
    expect(
      (await f.call("/agent", { token: rotated.data.credential.token })).data
        .websiteMarker,
    ).toBe(identity.websiteMarker);
    expect((await f.call("/me", { token: me.websiteMarker })).status).toBe(401);
    const w = await draft(f);
    expect(
      (
        await f.call("/works", {
          method: "POST",
          body: { ...w.body, originality: { verified: true } },
        })
      ).status,
    ).toBe(400);
  });
  it("publishes owner and original Agent attribution consistently across public projections", async () => {
    const f = fixture();
    f.services.verifyWebsite = async (input) => success(input);
    const own = await draft(f);
    const published = await f.call(path(own, "publish"), {
      method: "POST",
      body: body(own),
    });
    expect(published.data.originality.subject.kind).toBe("account");
    expect(published.data.originality.requestedUrl).toBe(own.body.websiteUrl);
    const owner = (await f.call("/me")).data;
    for (const query of [
      "/works",
      "/feed",
      "/feed?view=sites",
      "/feed?view=sites&builder=codex",
      "/feed?owner=" + owner.handle,
    ]) {
      const rows = (await f.call(query, { token: null })).data.items;
      expect((rows[0].work ?? rows[0]).originality).toEqual(
        published.data.originality,
      );
      expect(rows[0].work ?? rows[0]).not.toHaveProperty("originalityCheck");
    }
    expect(
      (await f.call("/works/" + own.workId, { token: null })).data.originality,
    ).toEqual(published.data.originality);
    const conventional = await f.call("/works", {
      method: "POST",
      body: {
        ...own.body,
        title: "Conventional website",
        aiDeclaration: false,
        aiTools: [],
      },
    });
    const conventionalPublished = await f.call(
      path(conventional.data, "publish"),
      {
        method: "POST",
        body: body(conventional.data),
      },
    );
    expect(conventionalPublished.status).toBe(200);
    expect(conventionalPublished.data.originality.subject.kind).toBe("account");
    expect(
      (await f.call("/feed?view=sites", { token: null })).data.items.map(
        (item: any) => item.id,
      ),
    ).not.toContain(conventional.data.workId);
    const ag = await activate(f),
      peer = await activate(f);
    const submitted = await draft(f, ag.token);
    const reviewed = await f.call(path(submitted, "publish"), {
      method: "POST",
      body: body(submitted),
    });
    expect(reviewed.status).toBe(200);
    expect(reviewed.data.originality.subject.id).toBe(ag.id);
    expect(reviewed.data.submittedBy.id).toBe(ag.id);
    expect(reviewed.data.publishedBy).toBeNull();
    expect(
      (
        await f.call(path(submitted, "verify-originality"), {
          token: peer.token,
          method: "POST",
          body: body(submitted),
        })
      ).status,
    ).toBe(404);
    const readonly = await activate(f, draftScopes);
    const draftOnly = await draft(f, readonly.token);
    expect(
      (
        await f.call(path(draftOnly, "verify-originality"), {
          token: readonly.token,
          method: "POST",
          body: body(draftOnly),
        })
      ).status,
    ).toBe(403);
  });
  it("does not match another creator or another Agent in the same household", async () => {
    const f = fixture(),
      other = await activate(f),
      original = await activate(f);
    const foreignMarkers = [
      (await f.call("/me", { token: "fixture:bob" })).data.websiteMarker,
      (await f.call("/agent", { token: other.token })).data.websiteMarker,
    ];
    f.services.verifyWebsite = async (input) => {
      expect(input.subjects.map((s) => s.marker)).not.toContain(
        foreignMarkers[0],
      );
      expect(input.subjects.map((s) => s.marker)).not.toContain(
        foreignMarkers[1],
      );
      return failedWebsiteCheck("marker_missing", input.url);
    };
    const work = await draft(f, original.token);
    const published = await f.call(path(work, "publish"), {
      method: "POST",
      body: body(work),
    });
    expect(published.status).toBe(200);
    expect(published.data.originality).toBeNull();
    expect(published.data.originalityCheck.reason).toBe("marker_missing");
  });
  it("isolates saved draft proofs and can recheck the public revision without publishing changes", async () => {
    const f = fixture();
    f.services.verifyWebsite = async (input) => success(input);
    const work = await draft(f);
    const published = (
      await f.call(path(work, "publish"), { method: "POST", body: body(work) })
    ).data;
    const edited = (
      await f.call("/works/" + work.workId, {
        method: "PATCH",
        body: {
          baseRevisionId: work.revisionId,
          content: {
            ...work.body,
            title: "A new private draft",
            websiteUrl: "https://creator.example.com/new",
          },
        },
      })
    ).data;
    expect(edited.originality).toBeNull();
    expect(
      (await f.call("/works/" + work.workId, { token: null })).data.originality,
    ).toEqual(published.originality);
    const timestamps = (
      await admin(
        "SELECT updated_at,published_at,first_published_at FROM musecity.works WHERE id=$1",
        [work.workId],
      )
    )[0];
    f.services.verifyWebsite = async (input) => {
      expect(input.url).toBe(work.body.websiteUrl);
      return failedWebsiteCheck("marker_missing", input.url);
    };
    const recheck = await f.call(path(work, "verify-originality"), {
      method: "POST",
      body: body(work),
    });
    expect(recheck.status).toBe(200);
    expect(recheck.data.work.revisionId).toBe(work.revisionId);
    expect(recheck.data.check.reason).toBe("marker_missing");
    expect(
      (await f.call("/works/" + work.workId, { token: null })).data.originality,
    ).toBeNull();
    expect(
      (await f.call("/works/" + work.workId + "?draft=true")).data.revisionId,
    ).toBe(edited.revisionId);
    expect(
      (
        await admin(
          "SELECT updated_at,published_at,first_published_at FROM musecity.works WHERE id=$1",
          [work.workId],
        )
      )[0],
    ).toEqual(timestamps);
    f.services.verifyWebsite = async (input) => success(input);
    const republished = await f.call(path(edited, "publish"), {
      method: "POST",
      body: body(edited),
    });
    expect(republished.data.originality.requestedUrl).toBe(
      edited.body.websiteUrl,
    );
    expect(
      (
        await f.call(path(work, "verify-originality"), {
          method: "POST",
          body: body(work),
        })
      ).status,
    ).toBe(409);
  });
  it("deduplicates commits and completed retries read current proofs without another webpage check", async () => {
    const f = fixture();
    let checks = 0;
    f.services.verifyWebsite = async (input) => {
      checks++;
      return success(input);
    };
    const work = await draft(f),
      key = "same-publish-key";
    const results = await Promise.all(
      [1, 2].map(() =>
        f.call(path(work, "publish"), {
          method: "POST",
          body: body(work),
          key,
        }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    expect(
      (
        await admin(
          "SELECT count(*)::integer AS n FROM musecity.activity WHERE resource_id=$1 AND action='work.publish'",
          [work.workId],
        )
      )[0].n,
    ).toBe(1);
    expect(
      (
        await admin(
          "SELECT count(*)::integer AS n FROM musecity.activity WHERE resource_id=$1 AND action='work.verify-originality'",
          [work.workId],
        )
      )[0].n,
    ).toBe(1);
    const before = checks;
    expect(
      (
        await f.call(path(work, "publish"), {
          method: "POST",
          body: body(work),
          key,
        })
      ).status,
    ).toBe(200);
    expect(checks).toBe(before);
    f.services.verifyWebsite = async (input) => {
      checks++;
      return failedWebsiteCheck("http_error", input.url);
    };
    await f.call(path(work, "verify-originality"), {
      method: "POST",
      body: body(work),
      key: "failed-manual-key",
    });
    const replay = await f.call(path(work, "publish"), {
      method: "POST",
      body: body(work),
      key,
    });
    expect(replay.data.originality).toBeNull();
    expect(checks).toBe(before + 1);
    await f.call(path(work, "verify-originality"), {
      method: "POST",
      body: body(work),
      key: "failed-manual-key",
    });
    expect(checks).toBe(before + 1);
  });
  it("keeps older slow checks from replacing newer results, without holding the write lock", async () => {
    const f = fixture();
    f.services.verifyWebsite = async (input) => success(input);
    const work = await draft(f);
    await f.call(path(work, "publish"), { method: "POST", body: body(work) });
    const gate = gates();
    let checks = 0;
    f.services.verifyWebsite = async (input) => {
      if (++checks === 1) {
        gate.enter();
        await gate.wait;
        return success(input);
      }
      return failedWebsiteCheck("marker_missing", input.url);
    };
    const slow = f.call(path(work, "verify-originality"), {
      method: "POST",
      body: body(work),
    });
    await gate.entered;
    const fast = await f.call(path(work, "verify-originality"), {
      method: "POST",
      body: body(work),
    });
    expect(fast.data.check.reason).toBe("marker_missing");
    gate.release();
    expect((await slow).data.check.reason).toBe("marker_missing");
    expect(
      (await f.call("/works/" + work.workId, { token: null })).data.originality,
    ).toBeNull();
  });
  it("rechecks revocation, moderation and changed publication targets after fetching", async () => {
    const f = fixture(),
      ag = await activate(f),
      work = await draft(f, ag.token),
      gate = gates();
    f.services.verifyWebsite = async (input) => {
      gate.enter();
      await gate.wait;
      return success(input);
    };
    const pending = f.call(path(work, "publish"), {
      token: ag.token,
      method: "POST",
      body: body(work),
    });
    await gate.entered;
    expect(
      (
        await f.call("/me/agents/" + ag.id + "/revoke", {
          method: "POST",
          body: { confirmed: true },
        })
      ).status,
    ).toBe(200);
    gate.release();
    expect([401, 403]).toContain((await pending).status);
    expect(
      (await f.call("/works/" + work.workId, { token: null })).status,
    ).toBe(404);
    const hidden = await draft(f),
      gate2 = gates();
    f.services.verifyWebsite = async (input) => {
      gate2.enter();
      await gate2.wait;
      return success(input);
    };
    const pendingHidden = f.call(path(hidden, "publish"), {
      method: "POST",
      body: body(hidden),
    });
    await gate2.entered;
    await admin("UPDATE musecity.works SET blocked=true WHERE id=$1", [
      hidden.workId,
    ]);
    gate2.release();
    expect((await pendingHidden).status).toBe(423);
    const changed = await draft(f),
      gate3 = gates();
    f.services.verifyWebsite = async (input) => {
      gate3.enter();
      await gate3.wait;
      return success(input);
    };
    const pendingChanged = f.call(path(changed, "publish"), {
      method: "POST",
      body: body(changed),
    });
    await gate3.entered;
    expect(
      (
        await f.call("/works/" + changed.workId, {
          method: "PATCH",
          body: {
            baseRevisionId: changed.revisionId,
            content: {
              ...changed.body,
              websiteUrl: "https://creator.example.com/changed",
            },
          },
        })
      ).status,
    ).toBe(200);
    gate3.release();
    expect((await pendingChanged).status).toBe(409);
  });
  it("shares the ten-check budget across a household while allowing ordinary publication", async ({
    onTestFinished,
  }) => {
    const now = vi.spyOn(Date, "now").mockReturnValue(Date.now());
    onTestFinished(() => now.mockRestore());
    const f = fixture(),
      ag = await activate(f),
      work = await draft(f, ag.token);
    let checks = 0;
    f.services.verifyWebsite = async (input) => {
      checks++;
      return success(input);
    };
    const prior = await draft(f, ag.token);
    const priorPublished = await f.call(path(prior, "publish"), {
      token: ag.token,
      method: "POST",
      body: body(prior),
    });
    expect(priorPublished.status).toBe(200);
    for (let i = 0; i < 9; i++)
      expect(
        (
          await f.call(path(work, "verify-originality"), {
            token: i % 2 ? ag.token : "fixture:alice",
            method: "POST",
            body: body(work),
          })
        ).status,
      ).toBe(200);
    const limited = await f.call(path(work, "verify-originality"), {
      method: "POST",
      body: body(work),
    });
    expect(limited.status).toBe(429);
    expect(limited.response.headers.get("Retry-After")).toBeTruthy();
    const retained = await f.call(path(prior, "publish"), {
      token: ag.token,
      method: "POST",
      body: body(prior),
    });
    expect(retained.status).toBe(200);
    expect(retained.data.originality).toEqual(priorPublished.data.originality);
    expect(retained.data.publishedAt).toEqual(priorPublished.data.publishedAt);
    expect(
      (await f.call("/works/" + prior.workId, { token: null })).data
        .originality,
    ).toEqual(priorPublished.data.originality);
    const published = await f.call(path(work, "publish"), {
      token: ag.token,
      method: "POST",
      body: body(work),
    });
    expect(published.status).toBe(200);
    expect(published.data.originality).toBeNull();
    expect(published.data.originalityCheck.reason).toBe("rate_limited");
    expect(checks).toBe(10);
  });
});
