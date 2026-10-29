import { beforeEach, describe, expect, it } from "vitest";
import { article, config, fixture, reset } from "./helpers";
import { withDatabase } from "../src/server/database";
import { RouterContextProvider } from "react-router";
import { servicesContext } from "../src/context";
import { loader as galleryLoader } from "../src/routes/site-gallery";
import { siteBuilders } from "../src/shared/site-builders";

beforeEach(reset);

async function cover(f: ReturnType<typeof fixture>, token = "fixture:alice") {
  const bytes = Uint8Array.from(
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4z8DQAAAEgQGADgLFJAAAAABJRU5ErkJggg==",
      "base64",
    ),
  );
  const upload = await f.call("/media/uploads", {
    method: "POST",
    token,
    body: { mimeType: "image/png", byteSize: bytes.length },
  });
  expect(upload.status).toBe(201);
  const put = await f.app.request("http://localhost" + upload.data.uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "image/png",
      "X-Upload-Token": upload.data.uploadToken,
    },
    body: bytes,
  });
  expect(put.status).toBe(200);
  expect(
    (
      await f.call("/media/" + upload.data.mediaId + "/complete", {
        method: "POST",
        token,
        body: {},
      })
    ).status,
  ).toBe(200);
  return upload.data.mediaId as string;
}

function website(coverMediaId: string, aiDeclaration: boolean | undefined) {
  return {
    type: "website",
    title: "A neighborhood website",
    description: "Made with AI",
    websiteUrl: "https://example.com",
    coverMediaId,
    aiDeclaration,
    aiTools: ["Test tool"],
    tagIds: ["design"],
  };
}

async function publish(
  f: ReturnType<typeof fixture>,
  body: unknown,
  token = "fixture:alice",
) {
  const draft = await f.call("/works", { method: "POST", token, body });
  expect(draft.status, JSON.stringify(draft.data)).toBe(201);
  const result = await f.call("/works/" + draft.data.workId + "/publish", {
    method: "POST",
    token,
    body: { revisionId: draft.data.revisionId },
  });
  expect(result.status, JSON.stringify(result.data)).toBe(200);
  return result.data;
}

describe("Sites through the real local PostgreSQL API", () => {
  it("classifies published source declarations, with matching SSR and sitemap lifecycle", async () => {
    const f = fixture(),
      image = await cover(f);
    const sitemap = async () => {
      const response = await f.app.request("http://localhost/sitemap.xml");
      expect(response.status).toBe(200);
      const xml = await response.text();
      if (!xml.includes("<sitemapindex")) return xml;
      const parts = [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);
      return (
        await Promise.all(
          parts.map(async (path) => {
            const part = await f.app.request(path);
            expect(part.status).toBe(200);
            return part.text();
          }),
        )
      ).join("");
    };
    const context = new RouterContextProvider();
    context.set(servicesContext, {
      appId: "",
      origin: "http://localhost",
      api: f.app,
    });
    const gallery = (path: string) =>
      galleryLoader({
        request: new Request("http://localhost" + path + ".data?_routes=route"),
        url: new URL(path, "http://localhost"),
        pattern: path,
        params: {},
        context,
      });
    const feed = async (id: string) =>
      (await f.call("/feed?view=sites&builder=" + id, { token: null })).data
        .items;
    for (const builder of siteBuilders) {
      expect(await sitemap()).toContain(
        "<loc>http://localhost" + builder.guidePath + "</loc>",
      );
      expect(await sitemap()).not.toContain(
        "<loc>http://localhost" + builder.path + "</loc>",
      );
      expect((await gallery(builder.path)).seo.noindex).toBe(true);
    }
    const codex = await publish(f, {
      ...website(image, true),
      aiTools: [" CODEX SITES "],
    });
    const currentCodex = await publish(f, {
      ...website(image, true),
      aiTools: ["chatgpt sites"],
    });
    const claude = await publish(f, {
      ...website(image, true),
      aiTools: ["cLaUdE ArTiFaCtS"],
    });
    const muse = await publish(f, {
      ...website(image, true),
      aiTools: ["Meta Muse", "Muse Artifacts"],
    });
    await publish(f, {
      ...website(image, true),
      aiTools: [
        "Codex",
        "Claude",
        "Claude Code",
        "Muse",
        "Not Claude Artifacts",
      ],
    });
    await publish(f, { ...website(image, false), aiTools: ["ChatGPT Sites"] });
    await publish(f, {
      ...article,
      aiDeclaration: true,
      aiTools: ["ChatGPT Sites"],
    });
    const draft = await f.call("/works", {
      method: "POST",
      body: {
        ...website(image, true),
        title: "PRIVATE SOURCE DRAFT",
        aiTools: ["Claude Artifacts"],
      },
    });
    expect(draft.status).toBe(201);
    expect(
      (await feed("codex")).map((item: { id: string }) => item.id).sort(),
    ).toEqual([codex.workId, currentCodex.workId].sort());
    expect(
      (await feed("claude")).map((item: { id: string }) => item.id),
    ).toEqual([claude.workId]);
    expect((await feed("muse")).map((item: { id: string }) => item.id)).toEqual(
      [muse.workId],
    );
    for (const builder of siteBuilders) {
      const result = await gallery(builder.path);
      expect(result.seo.noindex).toBe(false);
      expect(result.seo.canonical).toBe("http://localhost" + builder.path);
      expect(JSON.stringify(result)).not.toContain("PRIVATE SOURCE DRAFT");
      expect(await sitemap()).toContain(
        "<loc>http://localhost" + builder.path + "</loc>",
      );
    }
    const edit = await f.call("/works/" + claude.workId, {
      method: "PATCH",
      body: {
        baseRevisionId: claude.revisionId,
        content: {
          ...website(image, true),
          title: "PRIVATE RECLASSIFICATION",
          aiTools: ["Meta Muse"],
        },
      },
    });
    expect(edit.status).toBe(200);
    expect(await feed("claude")).toHaveLength(1);
    expect(await feed("muse")).toHaveLength(1);
    expect(JSON.stringify(await gallery("/claude-artifacts"))).not.toContain(
      "PRIVATE RECLASSIFICATION",
    );
    expect(
      (
        await f.call("/works/" + claude.workId + "/publish", {
          method: "POST",
          body: { revisionId: edit.data.revisionId },
        })
      ).status,
    ).toBe(200);
    expect(await feed("claude")).toHaveLength(0);
    expect(await feed("muse")).toHaveLength(2);
    expect((await gallery("/claude-artifacts")).seo.noindex).toBe(true);
    expect(await sitemap()).not.toContain(
      "<loc>http://localhost/claude-artifacts</loc>",
    );
    expect(
      (
        await f.call("/works/" + claude.workId + "/unpublish", {
          method: "POST",
          body: { revisionId: edit.data.revisionId },
        })
      ).status,
    ).toBe(200);
    await withDatabase(config.testAdminUrl, (db) =>
      db.query("UPDATE musecity.works SET blocked=true WHERE id=$1", [
        muse.workId,
      ]),
    );
    expect(await feed("muse")).toHaveLength(0);
    expect(await sitemap()).not.toContain(
      "<loc>http://localhost/muse-artifacts</loc>",
    );
    await withDatabase(config.testAdminUrl, (db) =>
      db.query("UPDATE musecity.accounts SET status='restricted' WHERE id=$1", [
        codex.owner.id,
      ]),
    );
    expect(await feed("codex")).toHaveLength(0);
    expect(await sitemap()).not.toContain(
      "<loc>http://localhost/codex-sites</loc>",
    );
  });

  it("rejects invalid builder filters and unsupported gallery combinations", async () => {
    const f = fixture();
    for (const query of [
      "builder=codex",
      "view=following&builder=codex",
      "view=sites&builder=unknown",
      "view=sites&builder=",
      "view=sites&builder=claude&kind=help",
    ]) {
      const result = await f.call("/feed?" + query, { token: null });
      expect(result.status).toBe(400);
      expect(result.data.error.code).toBe("INVALID_FILTER");
    }
    const context = new RouterContextProvider();
    context.set(servicesContext, {
      appId: "",
      origin: "http://localhost",
      api: f.app,
    });
    for (const [path, status] of [
      ["/codex-sites?cursor=bad", 400],
      ["/codex-sites?tag=design", 400],
      ["/unknown-sites", 404],
    ] as const)
      await expect(
        galleryLoader({
          request: new Request("http://localhost" + path),
          url: new URL(path, "http://localhost"),
          pattern: path,
          params: {},
          context,
        }),
      ).rejects.toMatchObject({ status });
  });
  it("collects declared AI websites from different owners and excludes other content", async () => {
    const f = fixture(),
      aliceCover = await cover(f),
      bobCover = await cover(f, "fixture:bob");
    const alice = await publish(f, website(aliceCover, true));
    const bob = await publish(f, website(bobCover, true), "fixture:bob");
    for (const declaration of [false, undefined])
      await publish(f, website(aliceCover, declaration));
    await publish(f, article);
    await publish(f, {
      type: "video",
      title: "AI video",
      description: "",
      videoUrl: "https://example.com/video",
      coverMediaId: aliceCover,
      aiDeclaration: true,
      aiTools: [],
      tagIds: ["design"],
    });
    expect(
      (
        await f.call("/posts", {
          method: "POST",
          body: {
            kind: "update",
            text: "An update about my site",
            tagIds: ["design"],
          },
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await f.call("/works", {
          method: "POST",
          body: website(aliceCover, true),
        })
      ).status,
    ).toBe(201);
    for (const token of [null, "fixture:alice", "fixture:bob"]) {
      const result = await f.call("/feed?view=sites", { token });
      expect(result.status).toBe(200);
      expect(
        result.data.items.map((item: { id: string }) => item.id).sort(),
      ).toEqual([alice.workId, bob.workId].sort());
      expect(
        result.data.items.every(
          (item: { kind: string }) => item.kind === "work",
        ),
      ).toBe(true);
    }
    expect(
      (await f.call("/feed?view=sites&tag=games", { token: null })).data.items,
    ).toEqual([]);
    expect(
      (
        await f.call("/feed?view=sites&owner=" + alice.owner.handle, {
          token: null,
        })
      ).data.items.map((item: { id: string }) => item.id),
    ).toEqual([alice.workId]);
    expect(
      (
        await f.call("/feed?view=sites&kind=work&type=website&tag=design", {
          token: null,
        })
      ).data.items,
    ).toHaveLength(2);
    for (const filter of [
      "kind=update",
      "kind=help",
      "type=article",
      "help=open",
    ])
      expect(
        (await f.call("/feed?view=sites&" + filter, { token: null })).data.error
          .code,
      ).toBe("INVALID_FILTER");
    expect((await f.call("/feed", { token: null })).data.items).toHaveLength(7);
  });

  it("uses the published declaration until republishing, and removes unpublished sites", async () => {
    const f = fixture(),
      image = await cover(f);
    const work = await publish(f, website(image, true));
    const edit = await f.call("/works/" + work.workId, {
      method: "PATCH",
      body: { baseRevisionId: work.revisionId, content: website(image, false) },
    });
    expect(edit.status).toBe(200);
    expect(
      (await f.call("/feed?view=sites", { token: null })).data.items,
    ).toHaveLength(1);
    expect(
      (
        await f.call("/works/" + work.workId + "/publish", {
          method: "POST",
          body: { revisionId: edit.data.revisionId },
        })
      ).status,
    ).toBe(200);
    expect(
      (await f.call("/feed?view=sites", { token: null })).data.items,
    ).toEqual([]);
    const restored = await f.call("/works/" + work.workId, {
      method: "PATCH",
      body: {
        baseRevisionId: edit.data.revisionId,
        content: website(image, true),
      },
    });
    expect(restored.status).toBe(200);
    expect(
      (
        await f.call("/works/" + work.workId + "/publish", {
          method: "POST",
          body: { revisionId: restored.data.revisionId },
        })
      ).status,
    ).toBe(200);
    expect(
      (await f.call("/feed?view=sites", { token: null })).data.items,
    ).toHaveLength(1);
    expect(
      (
        await f.call("/works/" + work.workId + "/unpublish", {
          method: "POST",
          body: { revisionId: restored.data.revisionId },
        })
      ).status,
    ).toBe(200);
    expect(
      (await f.call("/feed?view=sites", { token: null })).data.items,
    ).toEqual([]);
  });

  it("enforces household blocks, moderation and account restrictions", async () => {
    const f = fixture();
    const alice = await publish(f, website(await cover(f), true));
    const bob = await publish(
      f,
      website(await cover(f, "fixture:bob"), true),
      "fixture:bob",
    );
    expect(
      (
        await f.call("/me/blocks/" + alice.owner.id, {
          method: "PUT",
          token: "fixture:bob",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await f.call("/feed?view=sites", { token: "fixture:bob" })
      ).data.items.map((item: { id: string }) => item.id),
    ).toEqual([bob.workId]);
    expect(
      (await f.call("/feed?view=sites", { token: null })).data.items,
    ).toHaveLength(2);
    await withDatabase(config.testAdminUrl, async (d) => {
      await d.query("UPDATE musecity.works SET blocked=true WHERE id=$1", [
        bob.workId,
      ]);
      await d.query(
        "UPDATE musecity.accounts SET status='restricted' WHERE id=$1",
        [alice.owner.id],
      );
    });
    expect(
      (await f.call("/feed?view=sites", { token: null })).data.items,
    ).toEqual([]);
  });

  it("paginates across owners and keeps Sites cursors isolated from other feeds", async () => {
    const f = fixture(),
      covers = [await cover(f), await cover(f, "fixture:bob")];
    for (let i = 0; i < 21; i++)
      await publish(
        f,
        {
          ...website(covers[i % 2]!, true),
          title: "Site " + i,
          aiTools: ["Codex Sites"],
        },
        i % 2 ? "fixture:bob" : "fixture:alice",
      );
    const first = await f.call("/feed?view=sites", { token: null });
    expect(first.data.items).toHaveLength(20);
    expect(first.data.nextCursor).toEqual(expect.any(String));
    const cursor = encodeURIComponent(first.data.nextCursor);
    const second = await f.call("/feed?view=sites&cursor=" + cursor, {
      token: null,
    });
    expect(second.status).toBe(200);
    expect(second.data.items).toHaveLength(1);
    expect(second.data.nextCursor).toBeNull();
    expect(
      new Set(
        [...first.data.items, ...second.data.items].map(
          (item: { id: string }) => item.id,
        ),
      ).size,
    ).toBe(21);
    for (const query of ["", "view=sites&tag=design&"])
      expect(
        (await f.call("/feed?" + query + "cursor=" + cursor, { token: null }))
          .data.error.code,
      ).toBe("INVALID_CURSOR");
    const source = await f.call("/feed?view=sites&builder=codex", {
      token: null,
    });
    expect(source.data.items).toHaveLength(20);
    const sourceCursor = encodeURIComponent(source.data.nextCursor);
    expect(
      (
        await f.call("/feed?view=sites&builder=codex&cursor=" + sourceCursor, {
          token: null,
        })
      ).data.items,
    ).toHaveLength(1);
    for (const query of [
      "view=sites",
      "view=sites&builder=claude",
      "view=sites&builder=codex&tag=design",
    ])
      expect(
        (
          await f.call("/feed?" + query + "&cursor=" + sourceCursor, {
            token: null,
          })
        ).data.error.code,
      ).toBe("INVALID_CURSOR");
    expect(
      (
        await f.call("/feed?view=sites&builder=codex&cursor=" + sourceCursor, {
          token: "fixture:alice",
        })
      ).data.error.code,
    ).toBe("INVALID_CURSOR");
  });
});
