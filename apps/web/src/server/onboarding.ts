import type { Database } from "./database";
import { profile, type Actor } from "./auth";
import { postView, savePost } from "./community";
import { requireValue } from "./errors";
import { postSchema } from "../shared/contracts";
import type { OnboardingAction, OnboardingState } from "../shared/onboarding";

type Progress = {
  started_at: Date;
  introduction_post_id: string | null;
  hello_skipped: boolean;
  muse_skipped: boolean;
  finished_at: Date | null;
};
async function progress(db: Database, a: Actor) {
  return db.one<Progress>(
    "SELECT * FROM musecity.account_onboarding WHERE account_id=$1",
    [a.account.id],
  );
}
async function existingIntroduction(db: Database, a: Actor) {
  return db.one<{ id: string }>(
    "SELECT id FROM musecity.posts WHERE owner_account_id=$1 AND agent_id IS NULL AND kind='update' AND NOT deleted AND NOT blocked ORDER BY created_at,id LIMIT 1",
    [a.account.id],
  );
}
export async function onboardingState(
  db: Database,
  a: Actor,
): Promise<OnboardingState> {
  const saved = await progress(db, a);
  const introductionId =
    saved?.introduction_post_id ?? (await existingIntroduction(db, a))?.id;
  // Never return hidden/deleted content through the private progress projection.
  const visible =
    introductionId &&
    (await db.one<{ id: string }>(
      "SELECT id FROM musecity.posts WHERE id=$1 AND owner_account_id=$2 AND agent_id IS NULL AND NOT deleted AND NOT blocked",
      [introductionId, a.account.id],
    ));
  const agent = await db.one<{ id: string; name: string }>(
    `SELECT a.id,a.name FROM musecity.agents a WHERE a.owner_account_id=$1 AND a.status='active' AND (
      EXISTS(SELECT 1 FROM musecity.credentials c WHERE c.agent_id=a.id AND c.oauth_grant_id IS NULL AND c.revoked_at IS NULL AND c.expires_at>now()) OR
      EXISTS(SELECT 1 FROM musecity.oauth_grants g WHERE g.agent_id=a.id AND g.revoked_at IS NULL AND g.expires_at>now() AND g.connected_at IS NOT NULL)) ORDER BY a.created_at,a.id LIMIT 1`,
    [a.account.id],
  );
  const pending = agent
    ? undefined
    : await db.one<{
        id: string;
        kind: "invitation" | "registration";
        name: string;
        expires_at: Date;
      }>(
        `SELECT id,kind,name,expires_at FROM (
      SELECT id,'invitation' AS kind,name,expires_at,created_at FROM musecity.invitations WHERE owner_account_id=$1 AND used_at IS NULL AND cancelled_at IS NULL
      UNION ALL
      SELECT id,'registration' AS kind,name,expires_at,created_at FROM musecity.registrations WHERE owner_account_id=$1 AND status='approved'
    ) p ORDER BY (expires_at>now()) DESC,created_at DESC,id DESC LIMIT 1`,
        [a.account.id],
      );
  const awaitingOAuth =
    !agent &&
    (await db.one<{ id: string }>(
      "SELECT g.id FROM musecity.oauth_grants g JOIN musecity.agents a ON a.id=g.agent_id WHERE g.owner_account_id=$1 AND g.revoked_at IS NULL AND g.expires_at>now() AND g.connected_at IS NULL AND a.status='active' LIMIT 1",
      [a.account.id],
    ));
  return {
    profile: profile(a.account),
    startedAt: saved?.started_at.toISOString() ?? null,
    finishedAt: saved?.finished_at?.toISOString() ?? null,
    introduction: {
      status: introductionId
        ? "complete"
        : saved?.hello_skipped
          ? "skipped"
          : "pending",
      post: visible ? await postView(db, visible.id, a) : null,
    },
    muse: {
      status: agent
        ? "activated"
        : pending
          ? pending.expires_at <= new Date()
            ? "expired"
            : pending.kind === "invitation"
              ? "invited"
              : "awaiting_activation"
          : awaitingOAuth
            ? "awaiting_activation"
            : "pending",
      deferred: saved?.muse_skipped ?? false,
      agent: agent ?? null,
      pending: pending
        ? {
            id: pending.id,
            kind: pending.kind,
            name: pending.name,
            expiresAt: pending.expires_at.toISOString(),
          }
        : null,
    },
  };
}
async function start(db: Database, a: Actor) {
  await db.query(
    "INSERT INTO musecity.account_onboarding(account_id,introduction_post_id) VALUES($1,$2) ON CONFLICT(account_id) DO NOTHING",
    [a.account.id, (await existingIntroduction(db, a))?.id ?? null],
  );
}
function requireJoined(a: Actor) {
  requireValue(
    a.account.joined_at,
    409,
    "MOVE_IN_REQUIRED",
    "Set up your public profile before continuing.",
  );
}
export async function updateOnboarding(
  db: Database,
  a: Actor,
  action: OnboardingAction,
) {
  if (action.action !== "start") requireJoined(a);
  await start(db, a);
  if (action.action === "finish") {
    const state = await onboardingState(db, a);
    requireValue(
      state.introduction.status !== "pending" &&
        (state.muse.status === "activated" || state.muse.deferred),
      409,
      "ONBOARDING_INCOMPLETE",
      "Complete the optional steps or choose Do this later before finishing.",
    );
    await db.query(
      "UPDATE musecity.account_onboarding SET finished_at=COALESCE(finished_at,now()) WHERE account_id=$1",
      [a.account.id],
    );
  } else if (action.action === "skip" || action.action === "resume") {
    const column = action.step === "hello" ? "hello_skipped" : "muse_skipped";
    await db.query(
      `UPDATE musecity.account_onboarding SET ${column}=$2,finished_at=NULL WHERE account_id=$1`,
      [a.account.id, action.action === "skip"],
    );
  }
  // Cache only the action receipt; responses always project current business state.
  return { saved: true };
}
export async function publishIntroduction(
  db: Database,
  a: Actor,
  text: string,
) {
  requireJoined(a);
  await start(db, a);
  const saved = await progress(db, a);
  // The authenticated transaction holds the account lock. Even a new retry key
  // or two tabs cannot publish a second introduction for this account.
  let postId =
    saved?.introduction_post_id ?? (await existingIntroduction(db, a))?.id;
  if (!postId)
    postId = (await savePost(db, a, postSchema.parse({ kind: "update", text })))
      .id;
  await db.query(
    "UPDATE musecity.account_onboarding SET introduction_post_id=$2,hello_skipped=false WHERE account_id=$1",
    [a.account.id, postId],
  );
  return postId;
}
