import type { Database } from "./database";
import { requireValue } from "./errors";
import { siteBuilders } from "../shared/site-builders";

// Bounded chunks stay well below both the 50,000 URL and 50 MiB sitemap limits.
export const sitemapChunkSize = 1000;
export type SitemapEntry = { path: string; lastmod: Date | string | null };
const builderEntries = JSON.stringify(
  siteBuilders.map(({ path, guidePath, aliases }) => ({
    path,
    guidePath,
    aliases,
  })),
);
const entriesSql = `WITH public_works AS (
 SELECT w.id,w.published_at,r.tag_ids,r.payload FROM musecity.works w
 JOIN musecity.accounts a ON a.id=w.owner_account_id
 JOIN musecity.work_revisions r ON r.id=w.published_revision_id
 WHERE w.status='published' AND NOT w.blocked AND a.status='active'
), public_posts AS (
 SELECT p.id,p.updated_at,p.tag_ids FROM musecity.posts p
 JOIN musecity.accounts a ON a.id=p.owner_account_id
 WHERE NOT p.deleted AND NOT p.blocked AND a.status='active'
), builders AS (
 SELECT * FROM jsonb_to_recordset($1::jsonb) AS b(path text,"guidePath" text,aliases text[])
), entries AS (
 SELECT path,NULL::timestamptz AS lastmod FROM (VALUES ('/'),('/?view=sites'),('/neighbors'),('/governance'),('/agents'),('/agents/dot'),('/agents/mcp')) AS pages(path)
 UNION ALL SELECT "guidePath",NULL::timestamptz FROM builders
 UNION ALL SELECT b.path,NULL::timestamptz FROM builders b WHERE EXISTS(
 SELECT 1 FROM public_works w WHERE w.payload->>'type'='website' AND w.payload->'aiDeclaration'='true'::jsonb
 AND EXISTS(SELECT 1 FROM jsonb_array_elements_text(COALESCE(w.payload->'aiTools','[]'::jsonb)) AS tools(tool) WHERE lower(btrim(tool))=ANY(b.aliases)))
 UNION ALL SELECT '/works/'||id,published_at FROM public_works
 UNION ALL SELECT '/posts/'||id,updated_at FROM public_posts
 UNION ALL SELECT '/u/'||handle,NULL::timestamptz FROM musecity.accounts WHERE status='active'
 UNION ALL SELECT '/governance/'||p.id,NULL::timestamptz FROM musecity.proposals p
 JOIN musecity.accounts a ON a.id=p.owner_account_id WHERE NOT p.blocked AND a.status='active'
 UNION ALL SELECT '/?tag='||t.id,NULL::timestamptz FROM musecity.tags t WHERE t.enabled AND (
 EXISTS(SELECT 1 FROM public_works w WHERE t.id=ANY(w.tag_ids)) OR
 EXISTS(SELECT 1 FROM public_posts p WHERE t.id=ANY(p.tag_ids)))
)`;
export function xmlEscape(value: string) {
  return value.replace(
    /[<>&"']/g,
    (c) =>
      ({
        "<": "&lt;",
        ">": "&gt;",
        "&": "&amp;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!,
  );
}
const declaration = '<?xml version="1.0" encoding="UTF-8"?>';
export function sitemapXml(origin: string, entries: SitemapEntry[]) {
  return (
    declaration +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
    entries
      .map(
        (entry) =>
          "<url><loc>" +
          xmlEscape(new URL(entry.path, origin).href) +
          "</loc>" +
          (entry.lastmod
            ? "<lastmod>" + new Date(entry.lastmod).toISOString() + "</lastmod>"
            : "") +
          "</url>",
      )
      .join("") +
    "</urlset>"
  );
}
export function sitemapIndexXml(origin: string, count: number) {
  const chunks = Math.ceil(count / sitemapChunkSize);
  requireValue(
    chunks <= 50000,
    503,
    "SITEMAP_LIMIT",
    "Sitemap capacity exceeded.",
  );
  return (
    declaration +
    '<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
    Array.from(
      { length: chunks },
      (_, i) =>
        "<sitemap><loc>" +
        xmlEscape(new URL("/sitemaps/" + (i + 1) + ".xml", origin).href) +
        "</loc></sitemap>",
    ).join("") +
    "</sitemapindex>"
  );
}
export async function sitemap(db: Database, origin: string, part?: string) {
  if (part !== undefined)
    requireValue(
      /^[1-9]\d*\.xml$/.test(part),
      404,
      "NOT_FOUND",
      "Sitemap not found.",
    );
  const count = Number(
    (await db.one<{ count: string }>(
      entriesSql + " SELECT count(*) FROM entries",
      [builderEntries],
    ))!.count,
  );
  if (part === undefined && count > sitemapChunkSize)
    return sitemapIndexXml(origin, count);
  const page = part === undefined ? 1 : Number(part.slice(0, -4));
  requireValue(
    Number.isSafeInteger(page) && page <= Math.ceil(count / sitemapChunkSize),
    404,
    "NOT_FOUND",
    "Sitemap not found.",
  );
  const entries = await db.query<SitemapEntry>(
    entriesSql +
      " SELECT path,lastmod FROM entries ORDER BY path LIMIT $2 OFFSET $3",
    [builderEntries, sitemapChunkSize, (page - 1) * sitemapChunkSize],
  );
  return sitemapXml(origin, entries);
}
