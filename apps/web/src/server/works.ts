import { interactionSummaries } from "./interactions";
import type { Database } from "./database";
import type { WorkRow, RevisionRow } from "./schema";
import { catalog, validateTags } from "./tags";
import { type Actor, audit, dailyBudget, profileSql } from "./auth";
import { requireValue } from "./errors";
import { id } from "./crypto";
import {
  mediaIds,
  articleText,
  type WorkContent,
  type WorkView,
  type FeedPage,
  workTypes,
} from "../shared/contracts";

export async function validateContent(
  db: Database,
  a: Actor,
  body: WorkContent,
  publishing = false,
) {
  await validateTags(db, body.tagIds);
  const ids = mediaIds(body);
  if (ids.length) {
    const found = await db.query<{ id: string; status: string }>(
      "SELECT id,status FROM musecity.media WHERE id=ANY($1::text[]) AND owner_account_id=$2 AND ($3::text IS NULL OR agent_id=$3)",
      [ids, a.account.id, a.agent?.id ?? null],
    );
    requireValue(
      found.length === ids.length,
      404,
      "NOT_FOUND",
      "One or more images are not available to you.",
    );
    requireValue(
      found.every((m) => m.status === "ready"),
      409,
      "MEDIA_NOT_READY",
      "Wait for all images to finish uploading.",
    );
  }
  if (publishing && ["website", "video"].includes(body.type))
    requireValue(
      body.coverMediaId,
      400,
      "COVER_REQUIRED",
      "Add a cover before publishing.",
    );
}
export async function ownedWork(db: Database, a: Actor, workId: string) {
  const work = await db.one<WorkRow>(
    "SELECT * FROM musecity.works WHERE id=$1 AND owner_account_id=$2 AND ($3::text IS NULL OR created_by_agent_id=$3) AND status<>'deleted' FOR UPDATE",
    [workId, a.account.id, a.agent?.id ?? null],
  );
  requireValue(work, 404, "NOT_FOUND", "Creation not found.");
  return work;
}
export const originalitySql = (
  owner = "a",
) => `CASE WHEN o.status='verified' AND r.payload->>'type'='website' AND o.requested_url=r.payload->>'websiteUrl'
 THEN jsonb_build_object('requestedUrl',o.requested_url,'verifiedUrl',o.final_url,'verifiedAt',o.checked_at,
 'subject',CASE WHEN o.subject_kind='agent' AND o.subject_agent_id=w.created_by_agent_id
 THEN jsonb_build_object('kind','agent','id',s.id,'name',s.name)
 ELSE jsonb_build_object('kind','account','id',${owner}.id,'name',${owner}.name) END) ELSE NULL END`;
const viewSql = `SELECT w.id AS "workId",r.id AS "revisionId",w.published_revision_id AS "publishedRevisionId",w.status,r.payload AS body,
 ${originalitySql()} AS originality,
 ${profileSql("a")} AS owner,
 CASE WHEN s.id IS NULL THEN NULL ELSE jsonb_build_object('id',s.id,'name',s.name,'muse',(SELECT mb.token_id FROM musecity.muse_bindings mb WHERE mb.agent_id=s.id AND mb.ended_at IS NULL)) END AS "submittedBy",
 CASE WHEN p.id IS NULL THEN NULL ELSE jsonb_build_object('id',p.id,'name',p.name,'muse',(SELECT mb.token_id FROM musecity.muse_bindings mb WHERE mb.agent_id=p.id AND mb.ended_at IS NULL)) END AS "publishedBy",
 w.published_at AS "publishedAt",w.updated_at AS "updatedAt"
 FROM musecity.works w JOIN musecity.accounts a ON a.id=w.owner_account_id
 LEFT JOIN musecity.agents s ON s.id=w.created_by_agent_id LEFT JOIN musecity.agents p ON p.id=w.published_by_agent_id`;
export async function workView(
  db: Database,
  workId: string,
  a?: Actor,
  viewer = a,
): Promise<WorkView> {
  const own = a ? await ownedWork(db, a, workId) : null;
  const v = await db.one<WorkView>(
    viewSql +
      ` JOIN musecity.work_revisions r ON r.id=w.${a ? "draft" : "published"}_revision_id LEFT JOIN musecity.work_originality o ON o.revision_id=r.id WHERE w.id=$1 AND w.status<>'deleted' ${a ? "" : "AND w.status='published' AND NOT w.blocked AND a.status='active'"}`,
    [workId],
  );
  requireValue(v, 404, "NOT_FOUND", "Creation not found.");
  if (a)
    v.originalityCheck =
      (await db.one<{
        status: "verified" | "failed";
        reason: import("../shared/originality").OriginalityReason | null;
        checkedAt: string;
      }>(
        `SELECT status,reason,checked_at AS "checkedAt" FROM musecity.work_originality WHERE revision_id=$1 AND checked_at IS NOT NULL`,
        [v.revisionId],
      )) ?? null;
  v.interactions = (
    await interactionSummaries(db, [{ kind: "work", id: workId }], viewer)
  ).get("work:" + workId)!;
  return JSON.parse(
    JSON.stringify(own ? { ...v, restricted: own.blocked } : v),
  );
}
export async function feed(
  db: Database,
  params: URLSearchParams,
  a?: Actor,
): Promise<FeedPage> {
  const type = params.get("type");
  const tag = params.get("tag");
  const owner = params.get("owner");
  requireValue(
    !type || workTypes.includes(type as (typeof workTypes)[number]),
    400,
    "INVALID_FILTER",
    "Unknown creation format.",
  );
  requireValue(
    !(type && tag),
    400,
    "INVALID_FILTER",
    "Choose one type or topic.",
  );
  if (tag)
    requireValue(
      (await catalog(db)).some((t) => t.id === tag),
      400,
      "INVALID_FILTER",
      "Unknown topic.",
    );
  const values: unknown[] = [];
  const add = (v: unknown) => {
    values.push(v);
    return "$" + values.length;
  };
  const predicates = [
    a
      ? "w.status<>'deleted'"
      : "w.status='published' AND NOT w.blocked AND a.status='active'",
  ];
  if (a) {
    predicates.push("w.owner_account_id=" + add(a.account.id));
    if (a.agent) predicates.push("w.created_by_agent_id=" + add(a.agent.id));
  }
  if (type) predicates.push("r.payload->>'type'=" + add(type));
  if (tag) predicates.push("r.tag_ids @> ARRAY[" + add(tag) + "]::text[]");
  if (owner) predicates.push("a.handle=" + add(owner));
  const time = a ? "updated_at" : "published_at";
  if (params.get("cursor")) {
    let cur: { time: string; id: string; filter: string } | undefined;
    try {
      cur = JSON.parse(atob(params.get("cursor")!));
    } catch {
      /* validated below */
    }
    requireValue(
      cur &&
        typeof cur.id === "string" &&
        !isNaN(Date.parse(cur.time)) &&
        cur.filter ===
          `${type ?? ""}|${tag ?? ""}|${owner ?? ""}|${a?.key ?? ""}`,
      400,
      "INVALID_CURSOR",
      "Reload this list to continue.",
    );
    predicates.push(
      `(w.${time},w.id)<(${add(cur.time)}::timestamptz,${add(cur.id)})`,
    );
  }
  const rows = await db.query<WorkView>(
    viewSql +
      ` JOIN musecity.work_revisions r ON r.id=w.${a ? "draft" : "published"}_revision_id LEFT JOIN musecity.work_originality o ON o.revision_id=r.id WHERE ${predicates.join(" AND ")} ORDER BY w.${time} DESC,w.id DESC LIMIT 21`,
    values,
  );
  const items: WorkView[] = JSON.parse(JSON.stringify(rows.slice(0, 20)));
  const interactions = await interactionSummaries(
    db,
    items.map((w) => ({ kind: "work", id: w.workId })),
    a,
  );
  for (const item of items) {
    item.interactions = interactions.get("work:" + item.workId)!;
    if (!item.body.description && item.body.articleDocument)
      item.body.description = articleText(item.body.articleDocument).slice(
        0,
        240,
      );
    delete item.body.articleDocument;
    item.body.description = item.body.description.slice(0, 240);
  }
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > 20 && last
        ? btoa(
            JSON.stringify({
              time: a ? last.updatedAt : last.publishedAt,
              id: last.workId,
              filter: `${type ?? ""}|${tag ?? ""}|${owner ?? ""}|${a?.key ?? ""}`,
            }),
          )
        : null,
  };
}
async function revision(
  db: Database,
  a: Actor,
  workId: string,
  body: WorkContent,
) {
  await validateContent(db, a, body);
  const revisionId = id("rev");
  await db.query(
    "INSERT INTO musecity.work_revisions(id,work_id,payload,tag_ids,media_ids,editor_agent_id) VALUES($1,$2,$3,$4,$5,$6)",
    [
      revisionId,
      workId,
      JSON.stringify(body),
      body.tagIds,
      mediaIds(body),
      a.agent?.id ?? null,
    ],
  );
  await db.query(
    "UPDATE musecity.works SET draft_revision_id=$2,updated_at=date_trunc('milliseconds',clock_timestamp()) WHERE id=$1",
    [workId, revisionId],
  );
  return workView(db, workId, a);
}
export async function createWork(db: Database, a: Actor, body: WorkContent) {
  const workId = id("wrk");
  await db.query(
    "INSERT INTO musecity.works(id,owner_account_id,created_by_agent_id) VALUES($1,$2,$3)",
    [workId, a.account.id, a.agent?.id ?? null],
  );
  const result = await revision(db, a, workId, body);
  await audit(db, a, "work.create", workId);
  return result;
}
export async function editWork(
  db: Database,
  a: Actor,
  workId: string,
  baseRevisionId: string,
  body: WorkContent,
) {
  const w = await ownedWork(db, a, workId);
  requireValue(
    w.draft_revision_id === baseRevisionId,
    409,
    "REVISION_CONFLICT",
    "This draft changed. Reload it before saving.",
  );
  requireValue(
    !w.blocked,
    423,
    "CONTENT_BLOCKED",
    "This creation is restricted.",
  );
  const result = await revision(db, a, workId, body);
  await audit(db, a, "work.revise", workId);
  return result;
}
export async function changePublication(
  db: Database,
  a: Actor,
  workId: string,
  action: "publish" | "unpublish" | "delete",
  revisionId?: string,
) {
  const w = await ownedWork(db, a, workId);
  if (action === "publish") {
    requireValue(
      !w.blocked,
      423,
      "CONTENT_BLOCKED",
      "This creation is restricted.",
    );
    requireValue(
      w.draft_revision_id === revisionId,
      409,
      "REVISION_CONFLICT",
      "Publish the current saved revision.",
    );
    const r = await db.one<RevisionRow>(
      "SELECT * FROM musecity.work_revisions WHERE id=$1",
      [revisionId],
    );
    requireValue(r, 404, "NOT_FOUND", "Revision not found.");
    await validateContent(db, a, r.payload, true);
    if (w.published_revision_id !== revisionId || w.status !== "published") {
      if (!w.first_published_at) await dailyBudget(db, a, "publication");
      await db.query(
        "UPDATE musecity.works SET status='published',published_revision_id=$2,published_by_agent_id=$3,published_at=date_trunc('milliseconds',clock_timestamp()),first_published_at=COALESCE(first_published_at,date_trunc('milliseconds',clock_timestamp())),updated_at=date_trunc('milliseconds',clock_timestamp()) WHERE id=$1",
        [workId, revisionId, a.agent?.id ?? null],
      );
      await audit(db, a, "work.publish", workId);
    }
  } else {
    if (action === "unpublish")
      requireValue(
        w.draft_revision_id === revisionId,
        409,
        "REVISION_CONFLICT",
        "Reload the current revision before unpublishing.",
      );
    requireValue(
      action !== "delete" || !a.agent,
      403,
      "SCOPE_DENIED",
      "Only the owner can delete creations.",
    );
    await db.query(
      "UPDATE musecity.works SET status=$2,published_revision_id=NULL,published_by_agent_id=NULL,published_at=NULL,updated_at=date_trunc('milliseconds',clock_timestamp()) WHERE id=$1",
      [workId, action === "delete" ? "deleted" : "unpublished"],
    );
    await audit(db, a, "work." + action, workId);
  }
  return action === "delete"
    ? { workId, status: "deleted" }
    : workView(db, workId, a);
}
