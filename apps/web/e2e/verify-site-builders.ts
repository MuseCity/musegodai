// Run against e2e:serve on 127.0.0.1:5191. Synthetic fixtures never touch cloud data.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { withDatabase } from "../src/server/database";
import { assertLocalTarget } from "../scripts/local-target";
import { siteBuilders } from "../src/shared/site-builders";
import { siteSharingGuides } from "../src/shared/site-sharing-guides";

const origin = "http://127.0.0.1:5191";
const config = JSON.parse(readFileSync(".local/database.json", "utf8"));
assertLocalTarget(config.e2eAdminUrl, "musecity_e2e", "musecity_admin");
const prefix = "builder-qa-" + Date.now();
let checks = 0;
const check = (value: unknown, label: string) => {
  assert.ok(value, label);
  checks++;
};
const decode = (value: string) =>
  value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'");
async function readSitemap() {
  const response = await fetch(origin + "/sitemap.xml");
  check(response.ok, "sitemap root accessible");
  const root = await response.text();
  if (!root.includes("<sitemapindex")) return root;
  const urls = [...root.matchAll(/<loc>(.*?)<\/loc>/g)].map((match) =>
    decode(match[1]),
  );
  return (
    await Promise.all(
      urls.map(async (url) => {
        check(new URL(url).origin === origin, "local sitemap shard");
        const response = await fetch(url);
        check(response.ok, "sitemap shard accessible " + url);
        return response.text();
      }),
    )
  ).join("");
}
async function document(path: string, status = 200) {
  const response = await fetch(origin + path, {
    headers: { Connection: "close" },
  });
  check(response.status === status, path + " status " + response.status);
  const html = await response.text();
  return {
    html,
    visible: html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, ""),
    canonical: decode(
      html.match(/<link rel="canonical" href="([^"]+)"/)?.[1] ?? "",
    ),
  };
}
const meResponse = await fetch(origin + "/api/v1/me", {
  headers: { Authorization: "Bearer fixture:alice", Connection: "close" },
});
check(meResponse.ok, "local fixture account");
const me = (await meResponse.json()) as { id: string };

try {
  // Bulk pagination fixtures do not consume or alter normal publishing quotas.
  await withDatabase(config.e2eAdminUrl, (db) =>
    db.transaction(async () => {
      await db.query(
        `INSERT INTO musecity.works(id,owner_account_id,status,draft_revision_id,published_revision_id,published_at,first_published_at)
      SELECT $1||'-work-'||i,$2,'published',$1||'-rev-'||i,$1||'-rev-'||i,now()-i*interval '1 second',now()-i*interval '1 second' FROM generate_series(1,23) i`,
        [prefix, me.id],
      );
      await db.query(
        `INSERT INTO musecity.work_revisions(id,work_id,payload,tag_ids,media_ids)
      SELECT $1||'-rev-'||i,$1||'-work-'||i,jsonb_build_object('type','website','title',$1||' site '||i,'description','Synthetic local builder pagination acceptance','websiteUrl','https://example.com','aiDeclaration',true,'aiTools',jsonb_build_array(CASE WHEN i<=21 THEN 'Codex Sites' WHEN i=22 THEN 'Claude Artifacts' ELSE 'Meta Muse' END),'tagIds','[]'::jsonb),ARRAY[]::text[],ARRAY[]::text[] FROM generate_series(1,23) i`,
        [prefix],
      );
    }),
  );
  const sitemap = await readSitemap();
  const sites = await document("/?view=sites");
  for (const builder of siteBuilders) {
    check(
      sites.visible.includes('href="' + builder.path + '"'),
      "Sites links to " + builder.path,
    );
    for (const path of [builder.path, builder.guidePath]) {
      const page = await document(path + "?utm_source=acceptance");
      check(page.canonical === origin + path, "clean canonical " + path);
      check(
        page.html.includes('content="index, follow, max-image-preview:large"'),
        "indexable " + path,
      );
      check(
        page.visible.includes(
          path === builder.path ? builder.title : builder.guideTitle,
        ),
        "visible SSR heading " + path,
      );
      check(
        sitemap.includes("<loc>" + origin + path + "</loc>"),
        "sitemap includes " + path,
      );
      check(
        page.html.includes('property="og:title"') &&
          page.html.includes('name="twitter:card"'),
        "sharing metadata " + path,
      );
      const schema = page.html.match(
        /<script type="application\/ld\+json">([\s\S]*?)<\/script>/,
      )?.[1];
      check(
        schema &&
          JSON.parse(schema)["@type"] ===
            (path === builder.path ? "CollectionPage" : "TechArticle"),
        "matching schema " + path,
      );
      if (path === builder.guidePath) {
        for (const source of siteSharingGuides[builder.id].sources)
          check(
            page.visible.includes(source.url),
            "official source " + source.url,
          );
        check(page.visible.includes("2026"), "visible review date");
      }
    }
  }
  let path = "/codex-sites",
    pages = 0;
  const ids = new Set<string>();
  do {
    const page = await document(path);
    check(page.canonical === origin + path, "page-specific canonical");
    for (const id of [
      ...page.visible.matchAll(/href="\/works\/([^"?#]+)"/g),
    ].map((match) => match[1]))
      if (id.startsWith(prefix)) ids.add(id);
    const next = page.visible.match(
      /href="([^"<>]*\?cursor=[^"<>]+)"[^>]*>Load more/,
    )?.[1];
    path = next ? decode(next) : "";
    pages++;
    check(pages < 5, "bounded pagination");
  } while (path);
  check(
    ids.size === 21 && pages >= 2,
    "all 21 Codex records have crawlable pages",
  );
  const first = (await (
    await fetch(origin + "/api/v1/feed?view=sites&builder=codex")
  ).json()) as { nextCursor: string };
  await document(
    "/claude-artifacts?cursor=" + encodeURIComponent(first.nextCursor),
    400,
  );
  for (const path of [
    "/codex-sites?cursor=bad",
    "/codex-sites?builder=claude",
    "/codex-sites?tag=design",
  ])
    await document(path, 400);
  await document("/not-a-builder-gallery", 404);
  const legacy = await document("/?view=sites&builder=codex");
  check(
    legacy.html.includes('content="noindex, follow"'),
    "secondary builder filter is noindex",
  );
  const record = (await (
    await fetch(origin + "/api/v1/works/" + prefix + "-work-1")
  ).json()) as { body: Record<string, unknown>; revisionId: string };
  const draft = await fetch(origin + "/api/v1/works/" + prefix + "-work-1", {
    method: "PATCH",
    headers: {
      Authorization: "Bearer fixture:alice",
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: JSON.stringify({
      baseRevisionId: record.revisionId,
      content: {
        ...record.body,
        title: "PRIVATE BUILDER DRAFT",
        aiTools: ["Claude Artifacts"],
      },
    }),
  });
  check(draft.ok, "private draft update through API");
  for (const path of [
    "/codex-sites",
    "/claude-artifacts",
    "/works/" + prefix + "-work-1",
  ])
    check(
      !(await document(path)).html.includes("PRIVATE BUILDER DRAFT"),
      "private source edit is not exposed " + path,
    );
  // Remove only this script's fixtures, then verify their sources disappear when empty.
} finally {
  await withDatabase(config.e2eAdminUrl, (db) =>
    db.transaction(async () => {
      await db.query(
        "DELETE FROM musecity.work_revisions WHERE work_id LIKE $1",
        [prefix + "-work-%"],
      );
      await db.query("DELETE FROM musecity.works WHERE id LIKE $1", [
        prefix + "-work-%",
      ]);
    }),
  );
}
for (const builder of siteBuilders) {
  const feed = (await (
    await fetch(origin + "/api/v1/feed?view=sites&builder=" + builder.id)
  ).json()) as { items: unknown[] };
  const page = await document(builder.path);
  const map = await readSitemap();
  check(
    page.html.includes(
      feed.items.length
        ? 'content="index, follow, max-image-preview:large"'
        : 'content="noindex, follow"',
    ),
    "post-cleanup index policy " + builder.id,
  );
  check(
    map.includes("<loc>" + origin + builder.path + "</loc>") ===
      !!feed.items.length,
    "post-cleanup sitemap policy " + builder.id,
  );
}
mkdirSync(".local/site-builders", { recursive: true });
writeFileSync(
  ".local/site-builders/http-verification.json",
  JSON.stringify(
    {
      checks,
      origin,
      database: "127.0.0.1:65433/musecity_e2e",
      syntheticFixturesRemoved: true,
    },
    null,
    2,
  ),
);
console.log(JSON.stringify({ checks, syntheticFixturesRemoved: true }));
