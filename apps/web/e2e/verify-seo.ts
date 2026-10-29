// Real SSR/API checks against synthetic content in the isolated local database.
// Run with `pnpm e2e:serve` on port 5191. No cloud services or real identities.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { withDatabase } from "../src/server/database";
import { assertLocalTarget } from "../scripts/local-target";
import { governanceRules } from "../src/shared/governance";
const origin = "http://127.0.0.1:5191";
const config = JSON.parse(readFileSync(".local/database.json", "utf8"));
assertLocalTarget(config.e2eAdminUrl, "musecity_e2e", "musecity_admin");
const prefix = "seo-" + Date.now(),
  tag = prefix;
let checks = 0;
function check(value: unknown, message: string): asserts value {
  assert.ok(value, message);
  checks++;
}
const sql = (query: string, values: unknown[] = []) =>
  withDatabase(config.e2eAdminUrl, (d) => d.query(query, values));
async function call(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
) {
  const response = await fetch(origin + "/api/v1" + path, {
    method,
    headers: {
      Authorization: "Bearer fixture:alice",
      "Content-Type": "application/json",
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = (await response.json()) as any;
  check(
    response.ok,
    `${path}: ${response.status} ${JSON.stringify(result.error)}`,
  );
  return result;
}
const decode = (value: string) =>
  value
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
const locs = (xml: string) =>
  [...xml.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => decode(m[1]));
async function html(path: string, status = 200) {
  const response = await fetch(new URL(path, origin));
  check(
    response.status === status,
    `${path}: expected ${status}, got ${response.status}`,
  );
  const raw = await response.text();
  // Never count React Router's hydration payload as visible server-rendered text.
  const visible = raw.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "");
  return {
    raw,
    visible,
    canonical: decode(
      raw.match(/<link rel="canonical" href="([^"]+)"/)?.[1] ?? "",
    ),
  };
}
function metadata(
  page: Awaited<ReturnType<typeof html>>,
  path: string,
  name: string,
) {
  check(page.canonical === origin + path, "canonical: " + path);
  check(page.visible.includes(name), "SSR content: " + name);
  for (const field of [
    'name="description"',
    'property="og:title"',
    'property="og:image"',
    'name="twitter:card"',
  ])
    check(page.raw.includes(field), "metadata " + field);
  const schema = page.raw.match(
    /<script type="application\/ld\+json">([\s\S]*?)<\/script>/,
  )?.[1];
  check(schema, "structured data");
  JSON.parse(schema);
}
const me = await call("/me");
await sql("INSERT INTO musecity.tags(id,name) VALUES($1,$2)", [
  tag,
  "SEO verification " + prefix,
]);
// Bulk local fixtures exercise >40 records without bypassing production quotas or permissions.
await withDatabase(config.e2eAdminUrl, (db) =>
  db.transaction(async () => {
    await db.query(
      `INSERT INTO musecity.works(id,owner_account_id,status,draft_revision_id,published_revision_id,published_at,first_published_at)
    SELECT $1||'-work-'||i,$2,'published',$1||'-rev-'||i,$1||'-rev-'||i,date_trunc('milliseconds',now())-i*interval '1 second',date_trunc('milliseconds',now())-i*interval '1 second' FROM generate_series(1,45) i`,
      [prefix, me.id],
    );
    await db.query(
      `INSERT INTO musecity.work_revisions(id,work_id,payload,tag_ids,media_ids)
    SELECT $1||'-rev-'||i,$1||'-work-'||i,jsonb_build_object('type','website','title','SEO site '||i,'description','Synthetic local website '||i,'websiteUrl','https://example.com','aiDeclaration',true,'aiTools',jsonb_build_array('Test tool'),'tagIds',to_jsonb(ARRAY[$1])),ARRAY[$1],ARRAY[]::text[] FROM generate_series(1,45) i`,
      [prefix],
    );
    await db.query(
      `INSERT INTO musecity.comments(id,owner_account_id,work_id,text) SELECT $1||'-comment-'||i,$2,$1||'-work-1','SEO reply '||i FROM generate_series(1,45) i`,
      [prefix, me.id],
    );
    await db.query(
      `INSERT INTO musecity.posts(id,owner_account_id,kind,text) VALUES($1,$2,'update','SEO neighbor update')`,
      [prefix + "-neighbor-update", me.id],
    );
    await db.query(
      `INSERT INTO musecity.posts(id,owner_account_id,kind,text) VALUES($1,$2,'update','SEO update body')`,
      [prefix + "-update", me.id],
    );
    await db.query(
      `INSERT INTO musecity.proposals(id,owner_account_id,title,body,rules,created_at,starts_at,ends_at) VALUES($1,$2,'SEO proposal','Synthetic governance proposal',$3,now(),now(),now()+interval '7 days')`,
      [prefix + "-proposal", me.id, JSON.stringify(governanceRules)],
    );
  }),
);
async function traverse(start: string, pattern: RegExp, key: string) {
  let path = start;
  const ids: string[] = [],
    cursors = new Set<string>();
  for (let page = 0; page < 5; page++) {
    const document = await html(path);
    check(
      document.canonical === new URL(path, origin).href.split("#")[0],
      "pagination canonical",
    );
    ids.push(...[...document.visible.matchAll(pattern)].map((m) => m[1]));
    const more = [
      ...document.visible.matchAll(
        /<a\b[^>]*href="([^"]+)"[^>]*>Load more<\/a>/g,
      ),
    ]
      .map((m) => decode(m[1]))
      .find((href) => new URL(href, origin).searchParams.has(key));
    if (!more) break;
    const cursor = new URL(more, origin).searchParams.get(key)!;
    check(!cursors.has(cursor), "no cursor repetition");
    cursors.add(cursor);
    path = more;
  }
  check(
    ids.length === 45 && new Set(ids).size === 45,
    `SSR pagination exactly 45 unique ${key}: ${ids.length}/${new Set(ids).size}`,
  );
  check(cursors.size === 2, "three SSR pages");
}
await traverse(
  "/?view=sites&tag=" + tag,
  /<a[^>]*>SEO site (\d+)<\/a>/g,
  "cursor",
);
await traverse(
  "/works/" + prefix + "-work-1",
  /id="comment-([^"]+)"/g,
  "commentCursor",
);
for (const [path, name] of [
  ["/", "musecity"],
  ["/?view=sites", "AI-built websites"],
  ["/?tag=" + tag, "SEO verification"],
  ["/u/" + me.handle, me.name],
  ["/posts/" + prefix + "-neighbor-update", "SEO neighbor update"],
  ["/posts/" + prefix + "-update", "SEO update body"],
  ["/governance", "Governance"],
  ["/governance/" + prefix + "-proposal", "SEO proposal"],
  ["/agents/mcp", "MCP"],
])
  metadata(await html(path), path, name);
const workPath = "/works/" + prefix + "-work-1";
const focused = await html(
  workPath + "?comment=" + prefix + "-comment-45&utm_source=test",
);
check(
  focused.canonical === origin + workPath,
  "comment focus and tracking collapse to detail",
);
check(focused.visible.includes("SEO reply 45"), "focused comment is SSR");
check(
  /<a[^>]*rel="[^"]*ugc[^"]*"/.test(focused.visible) &&
    /<a[^>]*rel="[^"]*nofollow[^"]*"/.test(focused.visible),
  "user website link qualified",
);
for (const path of [
  "/?view=following",
  "/?kind=work",
  "/?view=sites&tag=" + tag,
  "/neighbors?q=test",
  "/settings",
  "/wallet",
  "/publish",
  "/share",
  "/me/content",
  "/me/agents",
  "/me/saved",
  "/notifications",
  "/moderation",
])
  check(
    (await html(path)).raw.includes('name="robots" content="noindex, follow"'),
    "noindex " + path,
  );
for (const path of [
  "/?tag=does-not-exist",
  "/?view=invalid",
  "/?view=sites&kind=help",
  "/?cursor=invalid",
  workPath + "?commentCursor=invalid",
])
  check(
    (await html(path, 400)).raw.includes("noindex"),
    "invalid filter noindex",
  );
await html("/works/does-not-exist", 404);
await html("/u/does-not-exist", 404);
// Real API publication + image lifecycle with a private draft revision.
async function upload() {
  const bytes = readFileSync("public/brand/icon.png");
  const media = await call("/media/uploads", {
    mimeType: "image/png",
    byteSize: bytes.length,
  });
  check(
    (
      await fetch(origin + media.uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Type": "image/png",
          "X-Upload-Token": media.uploadToken,
        },
        body: bytes,
      })
    ).ok,
    "upload",
  );
  await call("/media/" + media.mediaId + "/complete", {});
  return media.mediaId as string;
}
const cover = await upload(),
  privateCover = await upload();
const body = {
  type: "website",
  title: "SEO public version",
  description: "Public version description",
  websiteUrl: "https://example.com",
  coverMediaId: cover,
  aiDeclaration: true,
  aiTools: ["Test tool"],
  tagIds: [tag],
};
const draft = await call("/works", body),
  path = "/works/" + draft.workId;
async function mediaStatus(id: string, status: number) {
  check(
    (await fetch(origin + "/media/" + id + "?w=1536")).status === status,
    "media visibility " + status,
  );
}
async function sitemap() {
  const response = await fetch(origin + "/sitemap.xml");
  check(response.ok, "sitemap root accessible");
  const root = await response.text();
  if (!root.includes("<sitemapindex")) return root;
  return (
    await Promise.all(
      locs(root).map(async (url) => {
        check(new URL(url).origin === origin, "local sitemap shard");
        const shard = await fetch(url);
        check(shard.ok, "sitemap shard accessible " + url);
        return shard.text();
      }),
    )
  ).join("");
}
await html(path, 404);
await mediaStatus(cover, 404);
check(!(await sitemap()).includes(path), "draft not in sitemap");
await call(path + "/publish", { revisionId: draft.revisionId });
metadata(await html(path), path, body.title);
await mediaStatus(cover, 200);
const before = await sitemap();
check(before.includes(path), "published in sitemap");
const edited = await call(
  path,
  {
    baseRevisionId: draft.revisionId,
    content: {
      ...body,
      title: "SEO private draft",
      description: "Private draft description",
      coverMediaId: privateCover,
    },
  },
  "PATCH",
);
const publicPage = await html(path);
check(
  publicPage.raw.includes("<title>SEO public version — musegod.ai</title>") &&
    !publicPage.raw.includes("SEO private draft"),
  "HTML retains published revision",
);
check(
  before === (await sitemap()),
  "private draft leaves sitemap and lastmod unchanged",
);
await mediaStatus(privateCover, 404);
await call(path + "/publish", { revisionId: edited.revisionId });
metadata(await html(path), path, "SEO private draft");
await mediaStatus(privateCover, 200);
await sql("UPDATE musecity.works SET blocked=true WHERE id=$1", [draft.workId]);
await html(path, 404);
await mediaStatus(privateCover, 404);
check(!(await sitemap()).includes(path), "hidden removed");
await sql("UPDATE musecity.works SET blocked=false WHERE id=$1", [
  draft.workId,
]);
await call(path + "/unpublish", { revisionId: edited.revisionId });
await html(path, 404);
await mediaStatus(privateCover, 404);
check(!(await sitemap()).includes(path), "unpublished removed");
const urls = locs(await sitemap());
check(urls.length > 45, "public sitemap populated");
for (const url of urls) {
  const response = await fetch(url);
  check(response.status === 200, "sitemap publicly accessible " + url);
}
writeFileSync(
  ".local/seo-verification.json",
  JSON.stringify(
    {
      checks,
      origin,
      tag,
      workPath,
      profile: "/u/" + me.handle,
      sitemapUrls: urls.length,
      synthetic: true,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify({
    checks,
    sitemapUrls: urls.length,
    tag,
    workPath,
    scope: "local SSR, API, PostgreSQL and image store; simulated identity",
  }),
);
