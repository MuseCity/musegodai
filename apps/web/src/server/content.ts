import type { Database } from "./database";
import type { Actor } from "./auth";
import { requireValue } from "./errors";
import { decodeCursor, page } from "./community";
import { workTypes, type ManagedContent, type Page } from "../shared/contracts";

// This household-wide view is deliberately unavailable to Agent credentials.
export async function myContent(
  db: Database,
  actor: Actor,
  params: URLSearchParams,
): Promise<Page<ManagedContent>> {
  requireValue(
    !actor.agent,
    403,
    "HUMAN_REQUIRED",
    "Only the account owner can manage all content.",
  );
  const kind = params.get("kind"),
    status = params.get("status"),
    type = params.get("type");
  requireValue(
    [...params.keys()].every((key) =>
      ["kind", "status", "type", "cursor"].includes(key),
    ) &&
      (!kind || ["work", "update"].includes(kind)) &&
      (!status ||
        (kind === "work" &&
          ["draft", "published", "unpublished"].includes(status))) &&
      (!type ||
        (kind === "work" &&
          workTypes.includes(type as (typeof workTypes)[number]))),
    400,
    "INVALID_FILTER",
    "Choose filters for the selected content category.",
  );
  const filter = JSON.stringify([
    "my-content",
    actor.account.id,
    kind,
    status,
    type,
  ]);
  const cursor = decodeCursor(params.get("cursor"), filter);
  const rows = await db.query<{ item: ManagedContent }>(
    `
    WITH entries AS (
      SELECT w.id,'work' AS kind,w.updated_at,w.created_by_agent_id AS agent_id,w.blocked,
        jsonb_build_object('status',w.status,'format',r.payload->>'type','title',r.payload->>'title',
          'excerpt',left(COALESCE(r.payload->>'description',''),240),'revisionId',r.id,
          'publishedRevisionId',w.published_revision_id,
          'pendingChanges',w.status='published' AND r.id IS DISTINCT FROM w.published_revision_id) AS detail
      FROM musecity.works w JOIN musecity.work_revisions r ON r.id=w.draft_revision_id
      WHERE w.owner_account_id=$1 AND w.status<>'deleted' AND ($2::text IS NULL OR $2='work')
        AND ($3::text IS NULL OR w.status=$3) AND ($4::text IS NULL OR r.payload->>'type'=$4)
      UNION ALL
      SELECT p.id,p.kind,p.updated_at,p.agent_id,p.blocked,
        jsonb_build_object('status','published','title',left(p.text,100),
          'excerpt',left(p.text,240),'revision',p.revision)
      FROM musecity.posts p WHERE p.owner_account_id=$1 AND NOT p.deleted
        AND ($2::text IS NULL OR p.kind=$2)
    ) SELECT e.detail || jsonb_build_object('id',e.id,'kind',e.kind,'updatedAt',e.updated_at,'restricted',e.blocked,
      'agent',CASE WHEN a.id IS NULL THEN NULL ELSE jsonb_build_object('id',a.id,'name',a.name,'muse',(SELECT mb.token_id FROM musecity.muse_bindings mb WHERE mb.agent_id=a.id AND mb.ended_at IS NULL)) END) AS item
    FROM entries e LEFT JOIN musecity.agents a ON a.id=e.agent_id
    WHERE ($5::timestamptz IS NULL OR (e.updated_at,e.id)<($5,$6))
    ORDER BY e.updated_at DESC,e.id DESC LIMIT 21`,
    [
      actor.account.id,
      kind,
      status,
      type,
      cursor?.time ?? null,
      cursor?.id ?? null,
    ],
  );
  return page(
    rows.map((row) => row.item),
    filter,
    (item) => item.updatedAt,
  );
}
