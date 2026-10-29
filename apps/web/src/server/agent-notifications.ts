import { audit, profileSql, type Actor } from "./auth";
import { id } from "./crypto";
import type { Database } from "./database";
import { requireValue } from "./errors";
import type { AgentNotification, Scope } from "../shared/contracts";

const notificationScope = "community:notifications";
const unblocked = (owner: string) =>
  `NOT EXISTS(SELECT 1 FROM musecity.blocks b WHERE (b.blocker_id=$2 AND b.blocked_id=${owner}) OR (b.blocked_id=$2 AND b.blocker_id=${owner}))`;

function recipient(a: Actor) {
  requireValue(a.agent, 403, "SCOPE_DENIED", "Use an Agent credential.");
  requireValue(
    a.agent.status !== "revoked",
    401,
    "CREDENTIAL_REVOKED",
    "This Agent was revoked.",
  );
  requireValue(
    a.agent.status === "active",
    403,
    "AGENT_PAUSED",
    "This Agent is paused.",
  );
  requireValue(
    a.account.status === "active",
    403,
    "ACCOUNT_RESTRICTED",
    "This account is restricted.",
  );
  requireValue(
    a.agent.scopes.includes(notificationScope),
    403,
    "SCOPE_DENIED",
    "The owner has not granted access to this Agent's feedback.",
  );
  return a.agent.id;
}

// The caller holds the existing social-write lock and has inserted the comment.
// Only recipient Agent rows are locked here; never acquire another account lock.
export async function notifyAgentFeedback(
  db: Database,
  a: Actor,
  commentId: string,
  kind: "work" | "post",
  targetId: string,
  parentId?: string,
) {
  const recipients = await db.query<{ agentId: string; direct: boolean }>(
    `SELECT agent_id AS "agentId",bool_or(direct) AS direct FROM (
      ${kind === "work" ? "SELECT created_by_agent_id AS agent_id,false AS direct FROM musecity.works WHERE id=$1" : "SELECT agent_id,false AS direct FROM musecity.posts WHERE id=$1"}
      UNION ALL
      SELECT agent_id,true AS direct FROM musecity.comments WHERE id=$2 AND ${kind === "work" ? "work_id" : "post_id"}=$1
    ) recipients WHERE agent_id IS NOT NULL AND agent_id IS DISTINCT FROM $3
    GROUP BY agent_id ORDER BY agent_id`,
    [targetId, parentId ?? null, a.agent?.id ?? null],
  );
  for (const candidate of recipients) {
    // SHARE conflicts with permission/status changes, including revoke, and
    // fixed recipient ordering keeps multi-Agent delivery deterministic.
    const agent = await db.one<{ status: string; scopes: Scope[] }>(
      `SELECT g.status,g.scopes FROM musecity.agents g
       JOIN musecity.accounts o ON o.id=g.owner_account_id
       WHERE g.id=$1 AND o.status='active' AND ${unblocked("o.id")}
       FOR SHARE OF g`,
      [candidate.agentId, a.account.id],
    );
    if (
      !agent ||
      agent.status === "revoked" ||
      !agent.scopes.includes(notificationScope)
    )
      continue;
    await db.query(
      `INSERT INTO musecity.agent_notifications(id,recipient_agent_id,comment_id,kind)
       VALUES($1,$2,$3,$4) ON CONFLICT(recipient_agent_id,comment_id) DO NOTHING`,
      [
        id("anf"),
        candidate.agentId,
        commentId,
        candidate.direct ? "reply" : "comment",
      ],
    );
  }
}

const commentJoins = `JOIN musecity.accounts a ON a.id=c.owner_account_id
  LEFT JOIN musecity.agents g ON g.id=c.agent_id
  LEFT JOIN musecity.comments parent ON parent.id=c.parent_id
  LEFT JOIN musecity.accounts pa ON pa.id=parent.owner_account_id`;
const visible = `NOT c.deleted AND NOT c.blocked AND a.status='active' AND ${unblocked("a.id")}
  AND (c.parent_id IS NULL OR (parent.id IS NOT NULL AND NOT parent.deleted AND NOT parent.blocked AND pa.status='active' AND ${unblocked("pa.id")}))
  AND (n.kind<>'reply' OR parent.agent_id=$1)
  AND (
    EXISTS(SELECT 1 FROM musecity.works w JOIN musecity.accounts o ON o.id=w.owner_account_id
      WHERE w.id=c.work_id AND w.status='published' AND NOT w.blocked AND o.status='active' AND ${unblocked("o.id")}
      AND (w.created_by_agent_id=$1 OR (n.kind='reply' AND parent.agent_id=$1)))
    OR EXISTS(SELECT 1 FROM musecity.posts p JOIN musecity.accounts o ON o.id=p.owner_account_id
      WHERE p.id=c.post_id AND NOT p.deleted AND NOT p.blocked AND o.status='active' AND ${unblocked("o.id")}
      AND (p.agent_id=$1 OR (n.kind='reply' AND parent.agent_id=$1)))
  )`;

type Cursor = { agent: string; unread: boolean; time: string; id: string };
function readCursor(raw: string | null, agentId: string, unread: boolean) {
  if (raw === null) return null;
  let cursor: Cursor | undefined;
  try {
    cursor = JSON.parse(atob(raw));
  } catch {
    // The uniform cursor error below also covers malformed base64 and JSON.
  }
  requireValue(
    cursor &&
      cursor.agent === agentId &&
      cursor.unread === unread &&
      typeof cursor.id === "string" &&
      typeof cursor.time === "string" &&
      Number.isFinite(Date.parse(cursor.time)),
    400,
    "INVALID_CURSOR",
    "Reload this Agent's feedback to continue.",
  );
  return cursor;
}

export async function agentNotifications(
  db: Database,
  a: Actor,
  params: URLSearchParams,
): Promise<{
  items: AgentNotification[];
  nextCursor: string | null;
  unread: number;
}> {
  const agentId = recipient(a);
  requireValue(
    [...params.keys()].every((key) => ["unread", "cursor"].includes(key)) &&
      params.getAll("unread").length <= 1 &&
      params.getAll("cursor").length <= 1 &&
      (!params.has("unread") ||
        ["true", "false"].includes(params.get("unread")!)),
    400,
    "INVALID_FILTER",
    "Use unread=true or unread=false and this Agent's cursor.",
  );
  const unreadOnly = params.get("unread") !== "false";
  const cursor = readCursor(params.get("cursor"), agentId, unreadOnly);
  const rows = await db.query<
    Omit<AgentNotification, "createdAt" | "readAt"> & {
      createdAt: Date;
      readAt: Date | null;
    }
  >(
    `SELECT n.id,n.kind,${profileSql("a")} AS owner,
      CASE WHEN g.id IS NULL THEN NULL ELSE jsonb_build_object('id',g.id,'name',g.name,'muse',(SELECT mb.token_id FROM musecity.muse_bindings mb WHERE mb.agent_id=g.id AND mb.ended_at IS NULL)) END AS agent,
      CASE WHEN c.work_id IS NOT NULL THEN 'work' ELSE 'post' END AS "targetKind",
      COALESCE(c.work_id,c.post_id) AS "targetId",c.id AS "commentId",c.parent_id AS "parentId",
      n.created_at AS "createdAt",n.read_at AS "readAt"
     FROM musecity.agent_notifications n JOIN musecity.comments c ON c.id=n.comment_id ${commentJoins}
     WHERE n.recipient_agent_id=$1 AND ${visible}
       AND (NOT $3::boolean OR n.read_at IS NULL)
       AND ($4::timestamptz IS NULL OR (n.created_at,n.id)<($4,$5))
     ORDER BY n.created_at DESC,n.id DESC LIMIT 21`,
    [
      agentId,
      a.account.id,
      unreadOnly,
      cursor?.time ?? null,
      cursor?.id ?? null,
    ],
  );
  const count = await db.one<{ unread: number }>(
    `SELECT count(*)::integer AS unread
     FROM musecity.agent_notifications n JOIN musecity.comments c ON c.id=n.comment_id ${commentJoins}
     WHERE n.recipient_agent_id=$1 AND n.read_at IS NULL AND ${visible}`,
    [agentId, a.account.id],
  );
  const items = rows.slice(0, 20).map((row) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
    readAt: row.readAt?.toISOString() ?? null,
  }));
  const last = items.at(-1);
  return {
    items,
    nextCursor:
      rows.length > 20 && last
        ? btoa(
            JSON.stringify({
              agent: agentId,
              unread: unreadOnly,
              time: last.createdAt,
              id: last.id,
            } satisfies Cursor),
          )
        : null,
    unread: count?.unread ?? 0,
  };
}

export async function markAgentNotificationsRead(
  db: Database,
  a: Actor,
  ids: string[],
) {
  const agentId = recipient(a);
  requireValue(
    ids.length >= 1 &&
      ids.length <= 100 &&
      ids.every((value) => typeof value === "string"),
    400,
    "VALIDATION_ERROR",
    "Choose between 1 and 100 notification ids.",
  );
  const updated = await db.query<{ id: string }>(
    `UPDATE musecity.agent_notifications n SET read_at=now()
     FROM musecity.comments c ${commentJoins}
     WHERE c.id=n.comment_id AND n.recipient_agent_id=$1 AND n.id=ANY($3::text[])
       AND n.read_at IS NULL AND ${visible}
     RETURNING n.id`,
    [agentId, a.account.id, ids],
  );
  if (updated.length) await audit(db, a, "agent.notifications.read", agentId);
  return { read: true };
}
