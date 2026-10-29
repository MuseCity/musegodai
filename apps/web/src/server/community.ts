import { notifyAgentFeedback } from "./agent-notifications";
import { originalitySql } from "./works";
import { normalizeSearch, matchExcerpt } from "../shared/search";
import { interactionSummaries } from "./interactions";
import { siteBuilder } from "../shared/site-builders";
import type { InteractionKind, SavedItem } from "../shared/interactions";
import type { Database } from "./database";
import { profile, profileSql, audit, dailyBudget, type Actor } from "./auth";
import { id } from "./crypto";
import { requireValue } from "./errors";
import { ownMedia } from "./media";
import { catalog, validateTags } from "./tags";
import type { AccountRow } from "./schema";
import {
  workTypes,
  type PostContent,
  type PostView,
  type CommunityItem,
  type Page,
  type NeighborProfile,
  type CommentView,
  type CommunityNotification,
  type ReportView,
  type Profile,
  type Attribution,
  type PublicAgent,
  type PublicAgentCard,
  type WorkView,
} from "../shared/contracts";

type TargetKind = "work" | "post";
const agentSql = (alias: string) =>
  `CASE WHEN ${alias}.id IS NULL THEN NULL ELSE jsonb_build_object('id',${alias}.id,'name',${alias}.name,'muse',(SELECT mb.token_id FROM musecity.muse_bindings mb WHERE mb.agent_id=${alias}.id AND mb.ended_at IS NULL)) END`;
export const unblockedSql = (owner: string, viewer: string) =>
  `NOT EXISTS(SELECT 1 FROM musecity.blocks b WHERE (b.blocker_id=${viewer} AND b.blocked_id=${owner}) OR (b.blocked_id=${viewer} AND b.blocker_id=${owner}))`;
export async function requireUnblocked(
  db: Database,
  viewer: string,
  owner: string,
) {
  const blocked = await db.one(
    "SELECT 1 FROM musecity.blocks WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1)",
    [viewer, owner],
  );
  requireValue(
    !blocked,
    404,
    "NOT_FOUND",
    "This content or neighbor is unavailable.",
  );
}
export function decodeCursor(raw: string | null, filter: string) {
  if (!raw) return null;
  let c: { time: string; id: string; filter: string } | undefined;
  try {
    c = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        Uint8Array.from(atob(raw), (v) => v.charCodeAt(0)),
      ),
    );
  } catch {
    /* validated below */
  }
  requireValue(
    c &&
      typeof c.id === "string" &&
      typeof c.time === "string" &&
      Number.isFinite(Date.parse(c.time)) &&
      c.filter === filter,
    400,
    "INVALID_CURSOR",
    "Reload this list to continue.",
  );
  return c;
}
export function page<T extends { id: string }>(
  rows: T[],
  filter: string,
  time: (row: T) => string,
): Page<T> {
  const items = rows.slice(0, 20),
    last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > 20 && last
        ? btoa(
            String.fromCharCode(
              ...new TextEncoder().encode(
                JSON.stringify({ id: last.id, time: time(last), filter }),
              ),
            ),
          )
        : null,
  };
}
function rejectRetiredFilter(params: URLSearchParams) {
  requireValue(
    !params.has("ecosystem"),
    400,
    "INVALID_FILTER",
    "Ecosystem filtering is no longer supported. Remove ecosystem and reload the list.",
  );
}
export async function neighbors(
  db: Database,
  params: URLSearchParams,
  viewer?: Actor,
): Promise<Page<Profile> | Page<PublicAgentCard>> {
  rejectRetiredFilter(params);
  const query = normalizeSearch(params.get("q"));
  const view = params.get("view") ?? "people";
  requireValue(
    ["people", "agents"].includes(view),
    400,
    "INVALID_FILTER",
    "Choose People or Agents.",
  );
  requireValue(
    query.length <= 120,
    400,
    "INVALID_FILTER",
    "Search is too long.",
  );
  if (view === "agents") {
    const filter = JSON.stringify(["public-agents", query, viewer?.account.id]),
      cursor = decodeCursor(params.get("cursor"), filter);
    const rows = await db.query<{
      id: string;
      name: string;
      description: string;
      muse: number | null;
      owner: Profile;
      createdAt: Date;
    }>(
      `SELECT g.id,g.name,g.description,(SELECT mb.token_id FROM musecity.muse_bindings mb WHERE mb.agent_id=g.id AND mb.ended_at IS NULL) AS muse,${profileSql("a")} AS owner,g.created_at AS "createdAt"
       FROM musecity.agents g JOIN musecity.accounts a ON a.id=g.owner_account_id
       WHERE g.public_visible AND g.status<>'revoked' AND a.status='active' AND a.joined_at IS NOT NULL
       AND ${unblockedSql("a.id", "$2")}
       AND ($1='' OR strpos(lower(g.name||' '||g.description||' '||a.name||' '||a.handle),lower($1))>0)
       AND ($3::timestamptz IS NULL OR (g.created_at,g.id)<($3,$4)) ORDER BY g.created_at DESC,g.id DESC LIMIT 21`,
      [
        query,
        viewer?.account.id ?? null,
        cursor?.time ?? null,
        cursor?.id ?? null,
      ],
    );
    const result = page(rows, filter, (r) => r.createdAt.toISOString());
    return {
      ...result,
      items: result.items.map(({ createdAt, ...card }) => card),
    };
  }
  const filter = JSON.stringify(["neighbors", query, viewer?.account.id]),
    cursor = decodeCursor(params.get("cursor"), filter);
  const rows = await db.query<{ profile: Profile }>(
    `SELECT ${profileSql("a")} AS profile FROM musecity.accounts a
    WHERE a.status='active' AND a.joined_at IS NOT NULL
    AND ($1='' OR strpos(lower(a.name||' '||a.handle||' '||a.bio||' '||a.working_on||' '||a.can_help),lower($1))>0)
    AND ${unblockedSql("a.id", "$2")} AND ($3::timestamptz IS NULL OR (a.joined_at,a.id)<($3,$4))
    ORDER BY a.joined_at DESC,a.id DESC LIMIT 21`,
    [
      query,
      viewer?.account.id ?? null,
      cursor?.time ?? null,
      cursor?.id ?? null,
    ],
  );
  return page(
    rows.map((r) => r.profile),
    filter,
    (r) => r.joinedAt!,
  );
}
export async function neighbor(
  db: Database,
  handle: string,
  viewer?: Actor,
): Promise<NeighborProfile> {
  const a = await db.one<AccountRow>(
    "SELECT * FROM musecity.accounts WHERE handle=$1 AND status='active'",
    [handle],
  );
  requireValue(a, 404, "NOT_FOUND", "Neighbor not found.");
  if (viewer) await requireUnblocked(db, viewer.account.id, a.id);
  const agents = a.joined_at
    ? await db.query<PublicAgent>(
        "SELECT g.id,g.name,g.description,(SELECT mb.token_id FROM musecity.muse_bindings mb WHERE mb.agent_id=g.id AND mb.ended_at IS NULL) AS muse FROM musecity.agents g WHERE g.owner_account_id=$1 AND g.public_visible AND g.status<>'revoked' ORDER BY g.created_at,g.id",
        [a.id],
      )
    : [];
  return { ...profile(a), agents };
}
export async function target(
  db: Database,
  kind: TargetKind,
  targetId: string,
  viewer?: Actor,
  lock = false,
) {
  const row = await db.one<{ owner_account_id: string }>(
    kind === "work"
      ? `SELECT w.owner_account_id FROM musecity.works w JOIN musecity.accounts a ON a.id=w.owner_account_id WHERE w.id=$1 AND w.status='published' AND NOT w.blocked AND a.status='active' ${lock ? "FOR SHARE OF w" : ""}`
      : `SELECT p.owner_account_id FROM musecity.posts p JOIN musecity.accounts a ON a.id=p.owner_account_id WHERE p.id=$1 AND NOT p.deleted AND NOT p.blocked AND a.status='active' ${lock ? "FOR SHARE OF p" : ""}`,
    [targetId],
  );
  requireValue(row, 404, "NOT_FOUND", "This content is unavailable.");
  if (viewer)
    await requireUnblocked(db, viewer.account.id, row.owner_account_id);
  return row.owner_account_id;
}
const postSelect = `SELECT p.id,p.kind,p.text,p.media_ids AS "mediaIds",p.tag_ids AS "tagIds",p.revision,p.created_at AS "createdAt",p.updated_at AS "updatedAt",${profileSql("a")} AS owner,${agentSql("g")} AS agent
 FROM musecity.posts p JOIN musecity.accounts a ON a.id=p.owner_account_id LEFT JOIN musecity.agents g ON g.id=p.agent_id`;
export async function postView(
  db: Database,
  postId: string,
  viewer?: Actor,
): Promise<PostView> {
  await target(db, "post", postId, viewer);
  const row = await db.one<PostView>(postSelect + " WHERE p.id=$1", [postId]);
  requireValue(row, 404, "NOT_FOUND", "Post unavailable.");
  row.interactions = (
    await interactionSummaries(db, [{ kind: "post", id: postId }], viewer)
  ).get("post:" + postId)!;
  return JSON.parse(JSON.stringify(row));
}
export async function communityFeed(
  db: Database,
  params: URLSearchParams,
  viewer?: Actor,
  recent = false,
): Promise<Page<CommunityItem>> {
  rejectRetiredFilter(params);
  const view = params.get("view") ?? "latest",
    kind = params.get("kind"),
    type = params.get("type"),
    tag = params.get("tag"),
    owner = params.get("owner"),
    query = normalizeSearch(params.get("q")),
    agentId = params.get("agent"),
    builderId = params.get("builder"),
    builder = siteBuilder(builderId);
  requireValue(
    !params.has("help") && query.length <= 120,
    400,
    "INVALID_FILTER",
    "Use a search of at most 120 characters; help filters are retired.",
  );
  if (agentId) {
    requireValue(
      owner,
      400,
      "INVALID_FILTER",
      "Agent filtering requires an owner.",
    );
    const visible = await db.one(
      `SELECT g.id FROM musecity.agents g JOIN musecity.accounts a ON a.id=g.owner_account_id WHERE g.id=$1 AND a.handle=$2 AND g.public_visible AND g.status<>'revoked' AND a.status='active' AND a.joined_at IS NOT NULL AND ${unblockedSql("a.id", "$3")}`,
      [agentId, owner, viewer?.account.id ?? null],
    );
    requireValue(
      visible,
      404,
      "NOT_FOUND",
      "This public Agent is unavailable.",
    );
  }
  requireValue(
    !params.has("builder") || (view === "sites" && builder),
    400,
    "INVALID_FILTER",
    "Choose a supported builder within Sites.",
  );
  requireValue(
    ["latest", "following", "sites"].includes(view) &&
      (!kind || ["work", "update"].includes(kind)) &&
      (!type || workTypes.includes(type as (typeof workTypes)[number])),
    400,
    "INVALID_FILTER",
    "Choose valid community filters.",
  );
  requireValue(
    view !== "sites" ||
      ((!kind || kind === "work") && (!type || type === "website")),
    400,
    "INVALID_FILTER",
    "Sites contains AI-assisted websites only.",
  );
  requireValue(
    view !== "following" || viewer,
    401,
    "AUTH_REQUIRED",
    "Sign in to see your neighbors.",
  );
  if (tag)
    requireValue(
      (await catalog(db)).some((t) => t.id === tag),
      400,
      "INVALID_FILTER",
      "Unknown topic.",
    );
  const filter = JSON.stringify([
      "discovery-v1",
      view,
      kind,
      type,
      tag,
      owner,
      query,
      agentId,
      viewer?.account.id,
      ...(builder ? [builder.id] : []),
    ]),
    cursor = decodeCursor(params.get("cursor"), filter);
  const rows = await db.query<{
    id: string;
    kind: "work" | "update";
    createdAt: Date;
    commentCount: number;
    payload: unknown;
    searchText: string;
    owner: Profile;
    agent: Attribution;
  }>(
    `
 WITH entries AS (
 SELECT w.id,'work' AS kind,w.owner_account_id,w.created_by_agent_id AS agent_id,w.first_published_at AS created_at,r.search_text,
 jsonb_build_object('workId',w.id,'revisionId',r.id,'publishedRevisionId',r.id,'status',w.status,
 'body',r.payload-'articleDocument'||jsonb_build_object('description',left(COALESCE(NULLIF(r.payload->>'description',''),r.payload->>'title',''),240)),
 'submittedBy',${agentSql("s")},'publishedBy',${agentSql("p")},'publishedAt',w.published_at,'updatedAt',w.updated_at,'originality',${originalitySql("oa")}) AS payload
 FROM musecity.works w JOIN musecity.work_revisions r ON r.id=w.published_revision_id
 LEFT JOIN musecity.agents s ON s.id=w.created_by_agent_id LEFT JOIN musecity.agents p ON p.id=w.published_by_agent_id
 JOIN musecity.accounts oa ON oa.id=w.owner_account_id
 LEFT JOIN musecity.work_originality o ON o.revision_id=r.id
 WHERE w.status='published' AND NOT w.blocked AND ($1::text IS NULL OR r.payload->>'type'=$1) AND ($2::text IS NULL OR $2=ANY(r.tag_ids))
 AND ($7<>'sites' OR (r.payload->>'type'='website' AND r.payload->'aiDeclaration'='true'::jsonb))
 AND ($10::text[] IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(COALESCE(r.payload->'aiTools','[]'::jsonb)) AS tools(tool) WHERE lower(btrim(tool))=ANY($10)))
 UNION ALL
 SELECT p.id,p.kind,p.owner_account_id,p.agent_id,p.created_at,p.text AS search_text,
 jsonb_build_object('id',p.id,'kind',p.kind,'text',p.text,'mediaIds',p.media_ids,'tagIds',p.tag_ids,'revision',p.revision,'createdAt',p.created_at,'updatedAt',p.updated_at)
 FROM musecity.posts p WHERE NOT p.deleted AND NOT p.blocked AND $7<>'sites' AND $1::text IS NULL AND ($2::text IS NULL OR p.tag_ids @> ARRAY[$2]::text[])
 ) SELECT e.id,e.kind,e.created_at AS "createdAt",e.payload,CASE WHEN cardinality($3::text[])>0 THEN e.search_text ELSE '' END AS "searchText",${profileSql("a")} AS owner,${agentSql("g")} AS agent,
 (SELECT count(*)::integer FROM musecity.comments c JOIN musecity.accounts ca ON ca.id=c.owner_account_id WHERE (c.work_id=e.id OR c.post_id=e.id) AND NOT c.deleted AND NOT c.blocked AND ca.status='active' AND ${unblockedSql("ca.id", "$4")}) AS "commentCount"
 FROM entries e JOIN musecity.accounts a ON a.id=e.owner_account_id LEFT JOIN musecity.agents g ON g.id=e.agent_id
 ${
   recent
     ? `JOIN LATERAL (SELECT max(c.created_at) AS last_reply FROM musecity.comments c JOIN musecity.accounts ca ON ca.id=c.owner_account_id
 WHERE (c.work_id=e.id OR c.post_id=e.id) AND c.created_at>=clock_timestamp()-interval '7 days'
 AND c.owner_account_id<>e.owner_account_id AND NOT c.deleted AND NOT c.blocked AND ca.status='active' AND ${unblockedSql("ca.id", "$4")}) active ON active.last_reply IS NOT NULL`
     : ""
 }
 WHERE a.status='active' AND ${unblockedSql("a.id", "$4")}
 AND NOT EXISTS(SELECT 1 FROM unnest($3::text[]) term WHERE strpos(lower(e.search_text),lower(term))=0)
 AND ($11::text IS NULL OR e.agent_id=$11)
 AND ($5::text IS NULL OR e.kind=$5) AND ($6::text IS NULL OR a.handle=$6)
 AND ($7<>'following' OR EXISTS(SELECT 1 FROM musecity.follows f WHERE f.follower_id=$4 AND f.followed_id=a.id))
 AND ($8::timestamptz IS NULL OR (e.created_at,e.id)<($8,$9))
 ORDER BY ${recent ? "active.last_reply" : "e.created_at"} DESC,e.id DESC LIMIT ${recent ? 5 : 21}`,
    [
      type,
      tag,
      query ? query.split(" ") : [],
      viewer?.account.id ?? null,
      kind,
      owner,
      view,
      cursor?.time ?? null,
      cursor?.id ?? null,
      builder?.aliases ?? null,
      agentId,
    ],
  );
  const interactions = await interactionSummaries(
    db,
    rows.map((r) => ({ kind: r.kind === "work" ? "work" : "post", id: r.id })),
    viewer,
  );
  const items = rows.map((r) => {
    const common = {
      id: r.id,
      createdAt: r.createdAt.toISOString(),
      commentCount: r.commentCount,
      ...(query ? { matchExcerpt: matchExcerpt(r.searchText, query) } : {}),
    };
    return r.kind === "work"
      ? {
          ...common,
          kind: "work" as const,
          work: {
            ...(r.payload as Omit<WorkView, "owner">),
            owner: r.owner,
            interactions: interactions.get("work:" + r.id)!,
          },
        }
      : {
          ...common,
          kind: r.kind,
          post: {
            ...(r.payload as PostView),
            owner: r.owner,
            agent: r.agent,
            interactions: interactions.get("post:" + r.id)!,
          },
        };
  }) as CommunityItem[];
  return page(items, filter, (r) => r.createdAt);
}
export async function communityDiscovery(db: Database, viewer?: Actor) {
  const result = await communityFeed(db, new URLSearchParams(), viewer, true);
  return { items: result.items };
}
async function validateImages(db: Database, a: Actor, ids: string[]) {
  for (const mediaId of ids)
    requireValue(
      (await ownMedia(db, a, mediaId)).status === "ready",
      409,
      "MEDIA_NOT_READY",
      "Wait for all images to finish uploading.",
    );
}
export async function savePost(
  db: Database,
  a: Actor,
  content: PostContent,
  postId?: string,
  revision?: number,
) {
  await validateTags(db, content.tagIds);
  await validateImages(db, a, content.mediaIds);
  if (postId) {
    const existing = await db.one<{
      revision: number;
      blocked: boolean;
      kind: string;
    }>(
      "SELECT revision,blocked,kind FROM musecity.posts WHERE id=$1 AND owner_account_id=$2 AND ($3::text IS NULL OR agent_id=$3) AND NOT deleted FOR UPDATE",
      [postId, a.account.id, a.agent?.id ?? null],
    );
    requireValue(existing, 404, "NOT_FOUND", "Post not found.");
    requireValue(
      !existing.blocked,
      423,
      "CONTENT_BLOCKED",
      "This post is hidden by moderation.",
    );
    requireValue(
      existing.revision === revision,
      409,
      "REVISION_CONFLICT",
      "This post changed. Reload before editing.",
    );
    requireValue(
      existing.kind === content.kind,
      400,
      "VALIDATION_ERROR",
      "Keep the original post type.",
    );
    await db.query(
      "UPDATE musecity.posts SET text=$2,media_ids=$3,tag_ids=$4,revision=revision+1,updated_at=date_trunc('milliseconds',clock_timestamp()) WHERE id=$1",
      [postId, content.text, content.mediaIds, content.tagIds],
    );
  } else {
    await dailyBudget(db, a, "publication");
    postId = id("post");
    await db.query(
      "INSERT INTO musecity.posts(id,owner_account_id,agent_id,kind,text,media_ids,tag_ids) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [
        postId,
        a.account.id,
        a.agent?.id ?? null,
        content.kind,
        content.text,
        content.mediaIds,
        content.tagIds,
      ],
    );
  }
  await audit(db, a, revision ? "post.edit" : "post.publish", postId);
  return postView(db, postId, a);
}
export async function changePost(
  db: Database,
  a: Actor,
  postId: string,
  revision: number,
) {
  const row = await db.one<{
    revision: number;
    kind: string;
    blocked: boolean;
  }>(
    "SELECT revision,kind,blocked FROM musecity.posts WHERE id=$1 AND owner_account_id=$2 AND NOT deleted FOR UPDATE",
    [postId, a.account.id],
  );
  requireValue(row, 404, "NOT_FOUND", "Post not found.");
  requireValue(
    row.revision === revision,
    409,
    "REVISION_CONFLICT",
    "Reload this post before changing it.",
  );
  await db.query(
    "UPDATE musecity.posts SET deleted=true,revision=revision+1 WHERE id=$1",
    [postId],
  );
  await audit(db, a, "post.delete", postId);
  return { deleted: true };
}
export async function relation(db: Database, a: Actor, accountId: string) {
  return {
    following: !!(await db.one(
      "SELECT 1 FROM musecity.follows WHERE follower_id=$1 AND followed_id=$2",
      [a.account.id, accountId],
    )),
    blocked: !!(await db.one(
      "SELECT 1 FROM musecity.blocks WHERE blocker_id=$1 AND blocked_id=$2",
      [a.account.id, accountId],
    )),
  };
}
async function notify(
  db: Database,
  a: Actor,
  recipient: string,
  kind: string,
  targetKind: string,
  targetId: string,
  eventKey: string,
  commentId?: string,
) {
  if (recipient === a.account.id) return;
  if (
    await db.one(
      "SELECT 1 FROM musecity.blocks WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1)",
      [recipient, a.account.id],
    )
  )
    return;
  await db.query(
    "INSERT INTO musecity.notifications(id,recipient_id,actor_account_id,actor_agent_id,kind,target_kind,target_id,event_key,comment_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(recipient_id,event_key) DO NOTHING",
    [
      id("ntf"),
      recipient,
      a.account.id,
      a.agent?.id ?? null,
      kind,
      targetKind,
      targetId,
      eventKey,
      commentId ?? null,
    ],
  );
}
export async function follow(
  db: Database,
  a: Actor,
  accountId: string,
  enabled: boolean,
) {
  requireValue(
    a.account.id !== accountId,
    400,
    "VALIDATION_ERROR",
    "Choose another neighbor.",
  );
  if (enabled) {
    requireValue(
      await db.one(
        "SELECT 1 FROM musecity.accounts WHERE id=$1 AND joined_at IS NOT NULL AND status='active'",
        [accountId],
      ),
      404,
      "NOT_FOUND",
      "Neighbor not found.",
    );
    await requireUnblocked(db, a.account.id, accountId);
    const rows = await db.query(
      "INSERT INTO musecity.follows(follower_id,followed_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING followed_id",
      [a.account.id, accountId],
    );
    if (rows.length)
      await notify(
        db,
        a,
        accountId,
        "follow",
        "account",
        a.account.id,
        "follow:" + a.account.id,
      );
  } else
    await db.query(
      "DELETE FROM musecity.follows WHERE follower_id=$1 AND followed_id=$2",
      [a.account.id, accountId],
    );
  return relation(db, a, accountId);
}
export async function block(
  db: Database,
  a: Actor,
  accountId: string,
  enabled: boolean,
) {
  requireValue(
    a.account.id !== accountId,
    400,
    "VALIDATION_ERROR",
    "Choose another account.",
  );
  requireValue(
    await db.one("SELECT 1 FROM musecity.accounts WHERE id=$1", [accountId]),
    404,
    "NOT_FOUND",
    "Account not found.",
  );
  if (enabled) {
    await db.query(
      "INSERT INTO musecity.blocks(blocker_id,blocked_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [a.account.id, accountId],
    );
    await db.query(
      "DELETE FROM musecity.follows WHERE (follower_id=$1 AND followed_id=$2) OR (follower_id=$2 AND followed_id=$1)",
      [a.account.id, accountId],
    );
  } else
    await db.query(
      "DELETE FROM musecity.blocks WHERE blocker_id=$1 AND blocked_id=$2",
      [a.account.id, accountId],
    );
  return relation(db, a, accountId);
}
export async function comments(
  db: Database,
  kind: TargetKind,
  targetId: string,
  params: URLSearchParams,
  viewer?: Actor,
): Promise<Page<CommentView>> {
  await target(db, kind, targetId, viewer);
  const focusId = params.get("focus");
  const focus = focusId
    ? await db.one<{ time: Date; id: string }>(
        `SELECT c.id,c.created_at AS time FROM musecity.comments c JOIN musecity.accounts a ON a.id=c.owner_account_id WHERE c.id=$1 AND c.${kind === "work" ? "work_id" : "post_id"}=$2 AND NOT c.blocked AND a.status='active' AND ${unblockedSql("a.id", "$3")}`,
        [focusId, targetId, viewer?.account.id ?? null],
      )
    : null;
  requireValue(
    !focusId || focus,
    404,
    "NOT_FOUND",
    "This reply is unavailable.",
  );
  const filter = JSON.stringify([
      "comments",
      focusId,
      kind,
      targetId,
      viewer?.account.id,
    ]),
    cursor = decodeCursor(params.get("cursor"), filter);
  const rows = await db.query<CommentView>(
    `SELECT c.id,${profileSql("a")} AS owner,${agentSql("g")} AS agent,CASE WHEN c.deleted THEN '' ELSE c.text END AS text,c.deleted,c.parent_id AS "parentId",c.created_at AS "createdAt"
    FROM musecity.comments c JOIN musecity.accounts a ON a.id=c.owner_account_id LEFT JOIN musecity.agents g ON g.id=c.agent_id
    WHERE c.${kind === "work" ? "work_id" : "post_id"}=$1 AND NOT c.blocked AND a.status='active' AND ${unblockedSql("a.id", "$2")}
    AND ($3::timestamptz IS NULL OR (c.created_at,c.id)>($3,$4)) AND ($5::timestamptz IS NULL OR (c.created_at,c.id)>=($5,$6)) ORDER BY c.created_at,c.id LIMIT 21`,
    [
      targetId,
      viewer?.account.id ?? null,
      cursor?.time ?? null,
      cursor?.id ?? null,
      focus?.time ?? null,
      focus?.id ?? null,
    ],
  );
  const items = JSON.parse(JSON.stringify(rows)) as CommentView[];
  const interactions = await interactionSummaries(
    db,
    items.filter((c) => !c.deleted).map((c) => ({ kind: "comment", id: c.id })),
    viewer,
  );
  for (const c of items)
    c.interactions = interactions.get("comment:" + c.id) ?? {
      up: 0,
      down: 0,
      likes: 0,
      viewer: null,
    };
  return page(items, filter, (r) => r.createdAt);
}
export async function reply(
  db: Database,
  a: Actor,
  kind: TargetKind,
  targetId: string,
  text: string,
  parentId?: string,
) {
  const owner = await target(db, kind, targetId, a, true);
  let parentOwner: string | undefined;
  if (parentId) {
    const parent = await db.one<{ owner_account_id: string }>(
      `SELECT c.owner_account_id FROM musecity.comments c JOIN musecity.accounts a ON a.id=c.owner_account_id WHERE c.id=$1 AND c.${kind === "work" ? "work_id" : "post_id"}=$2 AND NOT c.deleted AND NOT c.blocked AND a.status='active' FOR SHARE OF c`,
      [parentId, targetId],
    );
    requireValue(parent, 404, "NOT_FOUND", "Reply is unavailable.");
    await requireUnblocked(db, a.account.id, parent.owner_account_id);
    parentOwner = parent.owner_account_id;
  }
  await dailyBudget(db, a, "reply");
  const commentId = id("cmt");
  await db.query(
    "INSERT INTO musecity.comments(id,owner_account_id,agent_id,work_id,post_id,parent_id,text) VALUES($1,$2,$3,$4,$5,$6,$7)",
    [
      commentId,
      a.account.id,
      a.agent?.id ?? null,
      kind === "work" ? targetId : null,
      kind === "post" ? targetId : null,
      parentId ?? null,
      text,
    ],
  );
  await notify(
    db,
    a,
    owner,
    parentOwner === owner ? "reply" : "comment",
    kind,
    targetId,
    commentId,
    commentId,
  );
  if (parentOwner && parentOwner !== owner)
    await notify(
      db,
      a,
      parentOwner,
      "reply",
      kind,
      targetId,
      commentId,
      commentId,
    );
  await notifyAgentFeedback(db, a, commentId, kind, targetId, parentId);
  await audit(db, a, "community.reply", commentId);
  return { id: commentId };
}
export async function deleteComment(db: Database, a: Actor, commentId: string) {
  const rows = await db.query(
    "UPDATE musecity.comments SET deleted=true,text='' WHERE id=$1 AND owner_account_id=$2 RETURNING id",
    [commentId, a.account.id],
  );
  requireValue(rows.length, 404, "NOT_FOUND", "Comment not found.");
  await audit(db, a, "comment.delete", commentId);
  return { deleted: true };
}
const notificationVisible = `a.status='active' AND ${unblockedSql("a.id", "$1")}
 AND (n.comment_id IS NULL OR EXISTS(SELECT 1 FROM musecity.comments c WHERE c.id=n.comment_id AND NOT c.deleted AND NOT c.blocked))
 AND ((n.target_kind='account' AND EXISTS(SELECT 1 FROM musecity.follows f WHERE f.follower_id=n.actor_account_id AND f.followed_id=n.recipient_id))
 OR (n.target_kind='work' AND EXISTS(SELECT 1 FROM musecity.works w JOIN musecity.accounts o ON o.id=w.owner_account_id WHERE w.id=n.target_id AND w.status='published' AND NOT w.blocked AND o.status='active' AND ${unblockedSql("o.id", "$1")}))
 OR (n.target_kind='post' AND EXISTS(SELECT 1 FROM musecity.posts p JOIN musecity.accounts o ON o.id=p.owner_account_id WHERE p.id=n.target_id AND NOT p.deleted AND NOT p.blocked AND o.status='active' AND ${unblockedSql("o.id", "$1")})))`;
export async function notifications(
  db: Database,
  a: Actor,
  params: URLSearchParams,
) {
  const filter = JSON.stringify(["notifications", a.account.id]),
    cursor = decodeCursor(params.get("cursor"), filter);
  const rows = await db.query<CommunityNotification>(
    `SELECT n.id,n.kind,${profileSql("a")} AS owner,${agentSql("g")} AS agent,n.target_kind AS "targetKind",n.target_id AS "targetId",n.comment_id AS "commentId",n.created_at AS "createdAt",n.read_at AS "readAt"
    FROM musecity.notifications n JOIN musecity.accounts a ON a.id=n.actor_account_id LEFT JOIN musecity.agents g ON g.id=n.actor_agent_id
    WHERE n.recipient_id=$1 AND ${notificationVisible} AND ($2::timestamptz IS NULL OR (n.created_at,n.id)<($2,$3)) ORDER BY n.created_at DESC,n.id DESC LIMIT 21`,
    [a.account.id, cursor?.time ?? null, cursor?.id ?? null],
  );
  const count = await db.one<{ n: number }>(
    `SELECT count(*)::integer AS n FROM musecity.notifications n JOIN musecity.accounts a ON a.id=n.actor_account_id WHERE n.recipient_id=$1 AND n.read_at IS NULL AND ${notificationVisible}`,
    [a.account.id],
  );
  return {
    ...page(
      JSON.parse(JSON.stringify(rows)) as CommunityNotification[],
      filter,
      (r) => r.createdAt,
    ),
    unread: count?.n ?? 0,
  };
}
export async function moderator(db: Database, a: Actor) {
  return (
    !a.agent &&
    !!(await db.one("SELECT 1 FROM musecity.moderators WHERE account_id=$1", [
      a.account.id,
    ]))
  );
}
export async function report(
  db: Database,
  a: Actor,
  kind: ReportView["targetKind"],
  targetId: string,
  reason: string,
) {
  if (kind === "work" || kind === "post")
    await target(db, kind, targetId, a, true);
  else if (kind === "proposal") {
    const p = await db.one<{ owner_account_id: string }>(
      "SELECT p.owner_account_id FROM musecity.proposals p JOIN musecity.accounts a ON a.id=p.owner_account_id WHERE p.id=$1 AND NOT p.blocked AND a.status='active'",
      [targetId],
    );
    requireValue(p, 404, "NOT_FOUND", "Proposal unavailable.");
    await requireUnblocked(db, a.account.id, p.owner_account_id);
  } else if (kind === "comment") {
    const c = await db.one<{
      work_id: string | null;
      post_id: string | null;
      owner_account_id: string;
    }>(
      "SELECT work_id,post_id,owner_account_id FROM musecity.comments WHERE id=$1 AND NOT deleted AND NOT blocked",
      [targetId],
    );
    requireValue(c, 404, "NOT_FOUND", "Comment unavailable.");
    await target(
      db,
      c.work_id ? "work" : "post",
      (c.work_id ?? c.post_id)!,
      a,
      true,
    );
    await requireUnblocked(db, a.account.id, c.owner_account_id);
  } else
    requireValue(
      await db.one(
        "SELECT 1 FROM musecity.accounts WHERE id=$1 AND status='active'",
        [targetId],
      ),
      404,
      "NOT_FOUND",
      "Account unavailable.",
    );
  const rows = await db.query<{ id: string }>(
    "INSERT INTO musecity.reports(id,reporter_id,target_kind,target_id,reason) VALUES($1,$2,$3,$4,$5) ON CONFLICT(reporter_id,target_kind,target_id) DO UPDATE SET reason=EXCLUDED.reason RETURNING id",
    [id("rpt"), a.account.id, kind, targetId, reason],
  );
  return { id: rows[0]!.id };
}
export async function reports(
  db: Database,
  a: Actor,
  params: URLSearchParams,
): Promise<Page<ReportView>> {
  requireValue(
    await moderator(db, a),
    403,
    "SCOPE_DENIED",
    "Moderator access is required.",
  );
  const filter = JSON.stringify(["reports", a.account.id]),
    cursor = decodeCursor(params.get("cursor"), filter);
  const rows = await db.query<ReportView>(
    `SELECT r.id,r.target_kind AS "targetKind",r.target_id AS "targetId",r.reason,r.status,r.created_at AS "createdAt",
    CASE r.target_kind WHEN 'work' THEN (SELECT left(v.payload->>'title'||E'\\n'||COALESCE(v.payload->>'description',''),2000) FROM musecity.works w LEFT JOIN musecity.work_revisions v ON v.id=w.published_revision_id WHERE w.id=r.target_id)
    WHEN 'post' THEN (SELECT left(p.text,2000) FROM musecity.posts p WHERE p.id=r.target_id)
    WHEN 'proposal' THEN (SELECT left(p.title||E'\\n'||p.body,2000) FROM musecity.proposals p WHERE p.id=r.target_id)
    WHEN 'comment' THEN (SELECT left(c.text,2000) FROM musecity.comments c WHERE c.id=r.target_id)
    ELSE (SELECT a.name||E'\\n'||a.bio FROM musecity.accounts a WHERE a.id=r.target_id) END AS preview,
    CASE r.target_kind WHEN 'work' THEN '/works/'||r.target_id WHEN 'post' THEN '/posts/'||r.target_id WHEN 'proposal' THEN '/governance/'||r.target_id
    WHEN 'comment' THEN (SELECT CASE WHEN c.work_id IS NOT NULL THEN '/works/'||c.work_id ELSE '/posts/'||c.post_id END||'#conversation' FROM musecity.comments c WHERE c.id=r.target_id)
    ELSE (SELECT '/u/'||a.handle FROM musecity.accounts a WHERE a.id=r.target_id) END AS "targetPath"
    FROM musecity.reports r WHERE ($1::timestamptz IS NULL OR (r.created_at,r.id)<($1,$2)) ORDER BY r.created_at DESC,r.id DESC LIMIT 21`,
    [cursor?.time ?? null, cursor?.id ?? null],
  );
  return page(
    JSON.parse(JSON.stringify(rows)) as ReportView[],
    filter,
    (r) => r.createdAt,
  );
}
export async function resolveReport(
  db: Database,
  a: Actor,
  reportId: string,
  action: "hide" | "dismiss" | "restore",
) {
  requireValue(
    await moderator(db, a),
    403,
    "SCOPE_DENIED",
    "Moderator access is required.",
  );
  const r = await db.one<{
    target_kind: ReportView["targetKind"];
    target_id: string;
    status: string;
  }>(
    "SELECT target_kind,target_id,status FROM musecity.reports WHERE id=$1 FOR UPDATE",
    [reportId],
  );
  requireValue(r, 404, "NOT_FOUND", "Report not found.");
  requireValue(
    action !== "restore" || r.status === "hidden",
    409,
    "REPORT_CONFLICT",
    "Only a hidden report can be restored.",
  );
  requireValue(
    action !== "dismiss" || r.status === "pending",
    409,
    "REPORT_CONFLICT",
    "Only pending reports can be dismissed.",
  );
  requireValue(
    r.target_kind !== "account" || r.target_id !== a.account.id,
    400,
    "VALIDATION_ERROR",
    "Ask another moderator to review your account.",
  );
  if (action !== "dismiss") {
    if (r.target_kind === "account")
      await db.query("UPDATE musecity.accounts SET status=$2 WHERE id=$1", [
        r.target_id,
        action === "hide" ? "restricted" : "active",
      ]);
    else {
      const table = {
        work: "works",
        post: "posts",
        comment: "comments",
        proposal: "proposals",
      }[r.target_kind];
      await db.query(`UPDATE musecity.${table} SET blocked=$2 WHERE id=$1`, [
        r.target_id,
        action === "hide",
      ]);
    }
  }
  const status = { hide: "hidden", dismiss: "dismissed", restore: "restored" }[
    action
  ];
  if (action === "dismiss")
    await db.query(
      "UPDATE musecity.reports SET status=$2,resolved_by=$3 WHERE id=$1",
      [reportId, status, a.account.id],
    );
  else
    await db.query(
      "UPDATE musecity.reports SET status=$3,resolved_by=$4 WHERE target_kind=$1 AND target_id=$2 AND (status IN ('pending','hidden') OR id=$5)",
      [r.target_kind, r.target_id, status, a.account.id, reportId],
    );
  await audit(db, a, "moderation." + action, r.target_id);
  return { status };
}

export async function interactionTarget(
  db: Database,
  kind: InteractionKind,
  targetId: string,
  viewer?: Actor,
) {
  if (kind !== "comment") return target(db, kind, targetId, viewer, true);
  const comment = await db.one<{
    owner_account_id: string;
    work_id: string | null;
    post_id: string | null;
  }>(
    `SELECT c.owner_account_id,c.work_id,c.post_id FROM musecity.comments c JOIN musecity.accounts a ON a.id=c.owner_account_id
     WHERE c.id=$1 AND NOT c.deleted AND NOT c.blocked AND a.status='active' FOR SHARE OF c`,
    [targetId],
  );
  requireValue(comment, 404, "NOT_FOUND", "This reply is unavailable.");
  if (viewer)
    await requireUnblocked(db, viewer.account.id, comment.owner_account_id);
  await target(
    db,
    comment.work_id ? "work" : "post",
    (comment.work_id ?? comment.post_id)!,
    viewer,
    true,
  );
  return comment.owner_account_id;
}

export async function savedContent(
  db: Database,
  viewer: Actor,
  params: URLSearchParams,
): Promise<Page<SavedItem>> {
  requireValue(
    [...params.keys()].every((key) => key === "cursor"),
    400,
    "INVALID_FILTER",
    "Only a saved-list cursor is supported.",
  );
  const filter = JSON.stringify(["saved", viewer.account.id]),
    cursor = decodeCursor(params.get("cursor"), filter);
  const rows = await db.query<SavedItem>(
    `
    WITH visible AS (
      SELECT w.id,'work' AS kind,w.owner_account_id,w.created_by_agent_id AS agent_id,r.payload->>'title' AS title,
       left(r.payload->>'description',240) AS excerpt,'/works/'||w.id AS path
      FROM musecity.works w JOIN musecity.work_revisions r ON r.id=w.published_revision_id
      WHERE w.status='published' AND NOT w.blocked
      UNION ALL
      SELECT p.id,'post',p.owner_account_id,p.agent_id,'Post',left(p.text,240),'/posts/'||p.id
      FROM musecity.posts p WHERE NOT p.deleted AND NOT p.blocked
      UNION ALL
      SELECT c.id,'comment',c.owner_account_id,c.agent_id,'Reply',left(c.text,240),
       CASE WHEN c.work_id IS NOT NULL THEN '/works/'||c.work_id ELSE '/posts/'||c.post_id END||'?comment='||c.id||'#comment-'||c.id
      FROM musecity.comments c
      LEFT JOIN musecity.works w ON w.id=c.work_id LEFT JOIN musecity.posts p ON p.id=c.post_id
      JOIN musecity.accounts pa ON pa.id=COALESCE(w.owner_account_id,p.owner_account_id)
      WHERE NOT c.deleted AND NOT c.blocked AND pa.status='active' AND ${unblockedSql("pa.id", "$1")}
       AND ((w.status='published' AND NOT w.blocked) OR (p.id IS NOT NULL AND NOT p.deleted AND NOT p.blocked))
    )
    SELECT e.id,e.kind,e.title,e.excerpt,e.path,${profileSql("a")} AS owner,${agentSql("g")} AS agent,i.saved_at AS "savedAt"
    FROM musecity.content_interactions i JOIN visible e ON e.kind=i.target_kind AND e.id=i.target_id
    JOIN musecity.accounts a ON a.id=e.owner_account_id LEFT JOIN musecity.agents g ON g.id=e.agent_id
    WHERE i.account_id=$1 AND i.saved_at IS NOT NULL AND a.status='active' AND ${unblockedSql("a.id", "$1")}
     AND ($2::timestamptz IS NULL OR (i.saved_at,i.target_id)<($2,$3))
    ORDER BY i.saved_at DESC,i.target_id DESC LIMIT 21`,
    [viewer.account.id, cursor?.time ?? null, cursor?.id ?? null],
  );
  const summaries = await interactionSummaries(
    db,
    rows.map((r) => ({ kind: r.kind, id: r.id })),
    viewer,
  );
  const items = JSON.parse(JSON.stringify(rows)) as SavedItem[];
  for (const item of items)
    item.interactions = summaries.get(item.kind + ":" + item.id)!;
  return page(items, filter, (r) => r.savedAt);
}
