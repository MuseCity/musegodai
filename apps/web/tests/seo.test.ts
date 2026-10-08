import { beforeEach, describe, expect, it } from "vitest";
import { article, config, fixture, reset } from "./helpers";
import { withDatabase } from "../src/server/database";
import { assertLocalTarget } from "../scripts/local-target";
import {
  canonicalPath,
  httpsRedirect,
  pageSeo,
  paginationHref,
  publicIndexable,
  seoMeta,
  withCursor,
  workSeo,
} from "../src/shared/seo";
import { sitemapChunkSize, sitemapXml } from "../src/server/seo";
import type { Page, CommentView } from "../src/shared/contracts";
import { RouterContextProvider } from "react-router";
import { servicesContext } from "../src/context";
import { publicRead } from "../src/route-data";
import { loader as guideLoader } from "../src/routes/mcp-guide";
import { loader as onboardingLoader } from "../src/routes/agent-onboarding";
import { loader as siteGuideLoader } from "../src/routes/site-guide";
import { loader as galleryLoader } from "../src/routes/site-gallery";
import { siteBuilders } from "../src/shared/site-builders";

const comments: Page<CommentView> = { items: [], nextCursor: null };
const origin = "https://musegod.ai";
beforeEach(reset);
async function admin(query: string, values: unknown[] = []) {
  assertLocalTarget(config.testAdminUrl, "musecity_test", "musecity_admin");
  return withDatabase(config.testAdminUrl, (d) => d.query(query, values));
}
const locations = (xml: string) =>
  [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) =>
    m[1].replaceAll("&amp;", "&"),
  );
describe("public search discovery", () => {
  it("uses React Router's normalized document URL for client loader metadata", () => {
    const context = new RouterContextProvider();
    context.set(servicesContext, { appId: "", origin, api: fixture().app });
    for (const [path, loader] of [
      ["/agents/mcp", guideLoader],
      ["/agents", onboardingLoader],
      ...siteBuilders.map(
        (builder) => [builder.guidePath, siteGuideLoader] as const,
      ),
    ] as const) {
      const result = loader({
        request: new Request(origin + path + ".data?_routes=route"),
        url: new URL(origin + path),
        pattern: path,
        params: {},
        context,
      });
      expect(result.seo.canonical).toBe(origin + path);
      expect(result.seo.noindex).toBe(false);
    }
  });
  it("preserves upstream failure status instead of rendering an indexable empty page", async () => {
    for (const status of [400, 404, 500, 503]) {
      const context = new RouterContextProvider();
      const api = fixture().app;
      api.fetch = async () => new Response("Unavailable", { status });
      context.set(servicesContext, {
        appId: "",
        origin,
        api,
      });
      await expect(
        publicRead(
          {
            request: new Request(origin),
            url: new URL(origin),
            pattern: "/",
            params: {},
            context,
          },
          "/feed",
        ),
      ).rejects.toMatchObject({ status });
      await expect(
        galleryLoader({
          request: new Request(origin + "/codex-sites"),
          url: new URL(origin + "/codex-sites"),
          pattern: "/codex-sites",
          params: {},
          context,
        }),
      ).rejects.toMatchObject({ status });
    }
  });
  it("keeps Sites, tags and pagination canonical while excluding private and filtered pages", () => {
    for (const path of [
      "/",
      "/?view=sites",
      "/?tag=design",
      "/u/alice",
      "/works/wrk_1",
      "/posts/post_1",
      "/governance",
      "/governance/prp_1",
      "/agents/mcp",
      "/agents",
      ...siteBuilders.flatMap((builder) => [builder.path, builder.guidePath]),
    ])
      expect(publicIndexable(new URL(path, origin))).toBe(true);
    for (const path of [
      "/?view=following",
      "/?kind=work",
      "/?q=design",
      "/?owner=alice&agent=agent_1",
      "/u/alice?agent=agent_1",
      "/u/alice?q=design",
      "/?view=sites&tag=design",
      "/?view=sites&builder=codex",
      "/neighbors?q=alice",
      "/u/alice?kind=work",
      "/posts/post_1?edit=1",
      "/publish",
      "/wallet",
      "/settings",
      "/me/content",
      "/me/saved",
      "/me/agents",
      "/agents/claim",
      "/notifications",
      "/moderation",
    ])
      expect(publicIndexable(new URL(path, origin))).toBe(false);
    expect(
      canonicalPath(
        new URL("/?utm_source=x&tag=design&cursor=abc%2B%2F%3D", origin),
      ),
    ).toBe("/?tag=design&cursor=abc%2B%2F%3D");
    for (const path of [
      "/?q=design&cursor=next",
      "/u/alice?agent=agent_1&q=design&cursor=next",
      "/neighbors?view=agents&q=design&cursor=next",
    ]) {
      const canonical = new URL(
        canonicalPath(new URL(path + "&utm_source=x", origin)),
        origin,
      );
      const expected = new URL(path, origin);
      expect(Object.fromEntries(canonical.searchParams)).toEqual(
        Object.fromEntries(expected.searchParams),
      );
    }
    expect(canonicalPath(new URL("/posts/p?comment=c&edit=1", origin))).toBe(
      "/posts/p",
    );
    expect(
      canonicalPath(new URL("/posts/p?commentCursor=next&comment=c", origin)),
    ).toBe("/posts/p?commentCursor=next");
    expect(withCursor("/feed?tag=design&cursor=old", "new")).toBe(
      "/feed?tag=design&cursor=new",
    );
    expect(paginationHref("/?view=sites&utm_source=x&cursor=old", "new")).toBe(
      "/?view=sites&cursor=new",
    );
    expect(paginationHref("/posts/p", "new", "commentCursor")).toBe(
      "/posts/p?commentCursor=new#conversation",
    );
    for (const builder of siteBuilders)
      expect(
        paginationHref(builder.path + "?utm_source=x&cursor=old", "next"),
      ).toBe(builder.path + "?cursor=next");
    const seo = pageSeo(origin, new URL("https://untrusted.example/works/w"), {
      title: "Test",
      description: "Summary",
    });
    expect(seo.canonical).toBe(origin + "/works/w");
    expect(seoMeta(seo).filter((m) => "title" in m)).toEqual([
      { title: "Test" },
    ]);
    expect(seoMeta(seo, new Error("Unavailable"))).toContainEqual({
      name: "robots",
      content: "noindex, follow",
    });
  });

  it("redirects production HTTP with its path and query, leaving the local HTTP runtime usable", () => {
    const redirect = httpsRedirect(
      new Request("http://musegod.ai/?view=sites&tag=design"),
      origin,
    )!;
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get("location")).toBe(
      origin + "/?view=sites&tag=design",
    );
    expect(httpsRedirect(new Request(origin), origin)).toBeNull();
    expect(
      httpsRedirect(
        new Request("http://127.0.0.1:5191/"),
        "http://127.0.0.1:5191",
      ),
    ).toBeNull();
  });

  it("tracks public revisions, tags, moderation and account status without exposing drafts or private timestamps", async () => {
    const f = fixture();
    const work = (await f.call("/works", { method: "POST", body: article }))
      .data;
    const sitemap = async () =>
      (await f.app.request("http://localhost/sitemap.xml")).text();
    expect(await sitemap()).not.toContain("/works/" + work.workId);
    const publicPages = locations(await sitemap());
    expect(publicPages).toContain("http://localhost/agents");
    expect(publicPages).not.toContain("http://localhost/me/agents");
    expect(publicPages).not.toContain("http://localhost/agents/claim");
    await f.call("/works/" + work.workId + "/publish", {
      method: "POST",
      body: { revisionId: work.revisionId },
    });
    const published = await sitemap();
    expect(published).toContain("/works/" + work.workId);
    expect(published).toContain("/?tag=design");
    const edit = await f.call("/works/" + work.workId, {
      method: "PATCH",
      body: {
        baseRevisionId: work.revisionId,
        content: { ...article, title: "PRIVATE DRAFT", tagIds: ["games"] },
      },
    });
    expect(edit.status).toBe(200);
    const current = (await f.call("/works/" + work.workId, { token: null }))
      .data;
    expect(
      workSeo(
        origin,
        new URL("/works/" + work.workId, origin),
        current,
        comments,
      ).title,
    ).toBe(article.title + " — musegod.ai");
    expect(await sitemap()).toBe(published);
    await f.call("/works/" + work.workId + "/publish", {
      method: "POST",
      body: { revisionId: edit.data.revisionId },
    });
    expect(await sitemap()).toContain("/?tag=games");
    expect(await sitemap()).not.toContain("/?tag=design");
    await admin("UPDATE musecity.works SET blocked=true WHERE id=$1", [
      work.workId,
    ]);
    expect(await sitemap()).not.toContain("/works/" + work.workId);
    await admin("UPDATE musecity.works SET blocked=false WHERE id=$1", [
      work.workId,
    ]);
    expect(
      (
        await f.call("/works/" + work.workId + "/unpublish", {
          method: "POST",
          body: { revisionId: edit.data.revisionId },
        })
      ).status,
    ).toBe(200);
    expect(await sitemap()).not.toContain("/works/" + work.workId);
    const post = (
      await f.call("/posts", {
        method: "POST",
        body: { kind: "update", text: "Public update", tagIds: ["design"] },
      })
    ).data;
    expect(await sitemap()).toContain("/posts/" + post.id);
    await admin(
      "UPDATE musecity.accounts SET status='restricted' WHERE id=$1",
      [post.owner.id],
    );
    const restricted = await sitemap();
    expect(restricted).not.toContain("/posts/" + post.id);
    expect(restricted).not.toContain("/u/" + post.owner.handle);
    expect(restricted).not.toContain("/?tag=design");
    const robots = await f.app.request("http://localhost/robots.txt");
    expect(robots.headers.get("content-type")).toContain("text/plain");
    expect(await robots.text()).toBe(
      "User-agent: *\nAllow: /\nSitemap: http://localhost/sitemap.xml\n",
    );
  });

  it("enumerates bounded sitemap shards with no duplicates and rejects invalid shard numbers", async () => {
    const f = fixture(),
      owner = (await f.call("/me")).data.id;
    await admin(
      "INSERT INTO musecity.posts(id,owner_account_id,kind,text) SELECT 'seo-shard-'||i,$1,'update','Sitemap fixture '||i FROM generate_series(1,$2) i",
      [owner, sitemapChunkSize + 10],
    );
    const index = await f.app.request("http://localhost/sitemap.xml");
    expect(index.headers.get("content-type")).toContain("application/xml");
    const parts = locations(await index.text());
    expect(parts).toHaveLength(2);
    const urls = (
      await Promise.all(
        parts.map(async (path) =>
          locations(await (await f.app.request(path)).text()),
        ),
      )
    ).flat();
    expect(urls.filter((u) => u.includes("/posts/seo-shard-"))).toHaveLength(
      sitemapChunkSize + 10,
    );
    expect(new Set(urls).size).toBe(urls.length);
    for (const part of [
      "0.xml",
      "-1.xml",
      "3.xml",
      "1x.xml",
      "9007199254740993.xml",
    ])
      expect(
        (await f.app.request("http://localhost/sitemaps/" + part)).status,
      ).toBe(404);
    expect(
      sitemapXml(origin, [{ path: "/?tag=a&cursor=x", lastmod: null }]),
    ).toContain("tag=a&amp;cursor=x");
  });

  it("traverses 45 public entries and 45 comments without reusing a cursor, and rejects another identity's cursor", async () => {
    const f = fixture(),
      owner = (await f.call("/me")).data.id;
    await admin(
      "INSERT INTO musecity.posts(id,owner_account_id,kind,text,tag_ids) SELECT 'seo-page-'||i,$1,'update','Entry '||i,ARRAY['design'] FROM generate_series(1,45) i",
      [owner],
    );
    await admin(
      "INSERT INTO musecity.comments(id,owner_account_id,post_id,text) SELECT 'seo-comment-'||i,$1,'seo-page-1','Reply '||i FROM generate_series(1,45) i",
      [owner],
    );
    for (const start of ["/feed?tag=design", "/posts/seo-page-1/comments"]) {
      let path = start;
      const ids: string[] = [],
        cursors = new Set<string>();
      for (let i = 0; i < 4; i++) {
        const result = await f.call(path, { token: null });
        expect(result.status).toBe(200);
        ids.push(...result.data.items.map((item: { id: string }) => item.id));
        if (!result.data.nextCursor) break;
        expect(cursors.has(result.data.nextCursor)).toBe(false);
        cursors.add(result.data.nextCursor);
        path = withCursor(path, result.data.nextCursor);
        expect((await f.call(path)).status).toBe(400);
      }
      expect(ids).toHaveLength(45);
      expect(new Set(ids).size).toBe(45);
      expect(cursors.size).toBe(2);
    }
  });
});
