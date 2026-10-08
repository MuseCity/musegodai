import type { Database } from "./database";
import { audit, dailyBudget, profileSql, type Actor } from "./auth";
import { decodeCursor, moderator, page, unblockedSql } from "./community";
import { id } from "./crypto";
import { requireValue } from "./errors";
import { membership, type WalletServices } from "./wallets";
import {
  governanceRules,
  type GovernanceRules,
  type Proposal,
  type VoteChoice,
} from "../shared/governance";

type ProposalRow = {
  id: string;
  owner_account_id: string;
  rules: GovernanceRules;
  starts_at: Date;
  ends_at: Date;
  cancelled_at: Date | null;
};
const visible = `NOT p.blocked AND a.status='active' AND ${unblockedSql("p.owner_account_id", "$2")}`;
async function lockedProposal(db: Database, proposalId: string, a: Actor) {
  const p = await db.one<ProposalRow>(
    `SELECT p.* FROM musecity.proposals p JOIN musecity.accounts a ON a.id=p.owner_account_id WHERE p.id=$1 AND ${visible} FOR UPDATE OF p`,
    [proposalId, a.account.id],
  );
  requireValue(p, 404, "NOT_FOUND", "Proposal unavailable.");
  return p;
}
export async function proposalView(
  db: Database,
  proposalId: string,
  viewer?: Actor,
): Promise<Proposal> {
  const p = await db.one<
    Omit<Proposal, "status" | "canCancel" | "canRecordExecution">
  >(
    `
    SELECT p.id,p.title,p.body,${profileSql("a")} AS owner,p.created_at AS "createdAt",p.starts_at AS "startsAt",p.ends_at AS "endsAt",
      clock_timestamp() AS "serverTime",p.rules,
      CASE WHEN p.cancelled_at IS NULL THEN NULL ELSE jsonb_build_object('reason',p.cancellation_reason,'at',p.cancelled_at) END AS cancellation,
      CASE WHEN p.executed_at IS NULL THEN NULL ELSE jsonb_build_object('result',p.execution_result,'at',p.executed_at) END AS execution,
      jsonb_build_object('participants',t.participants,'for',t.yes,'against',t.no,'abstain',t.abstain) AS results,
      (SELECT jsonb_build_object('choice',v.choice,'weight',v.weight,'checkedAt',v.checked_at) FROM musecity.proposal_votes v WHERE v.proposal_id=p.id AND v.account_id=$2) AS "myVote"
    FROM musecity.proposals p JOIN musecity.accounts a ON a.id=p.owner_account_id
    CROSS JOIN LATERAL (SELECT count(*)::int AS participants,
      COALESCE(sum(weight) FILTER(WHERE choice='for'),0)::int AS yes,
      COALESCE(sum(weight) FILTER(WHERE choice='against'),0)::int AS no,
      COALESCE(sum(weight) FILTER(WHERE choice='abstain'),0)::int AS abstain
      FROM musecity.proposal_votes WHERE proposal_id=p.id) t
    WHERE p.id=$1 AND ${visible}`,
    [proposalId, viewer?.account.id ?? null],
  );
  requireValue(p, 404, "NOT_FOUND", "Proposal unavailable.");
  const value = JSON.parse(JSON.stringify(p)) as typeof p;
  const time = Date.parse(value.serverTime);
  const status: Proposal["status"] = value.cancellation
    ? "cancelled"
    : time < Date.parse(value.startsAt)
      ? "announcement"
      : time < Date.parse(value.endsAt)
        ? "voting"
        : value.results.participants >= value.rules.quorum &&
            value.results.for > value.results.against
          ? "passed"
          : "failed";
  const operator = !!viewer && (await moderator(db, viewer));
  return {
    ...value,
    status,
    canCancel:
      !!viewer &&
      !viewer.agent &&
      (viewer.account.id === value.owner.id || operator) &&
      (status === "announcement" || status === "voting"),
    canRecordExecution: operator && status === "passed" && !value.execution,
  };
}
export async function proposals(
  db: Database,
  params: URLSearchParams,
  viewer?: Actor,
) {
  const filter = JSON.stringify(["proposals", viewer?.account.id ?? "public"]);
  const cursor = decodeCursor(params.get("cursor"), filter);
  const rows = await db.query<{ id: string }>(
    `SELECT p.id FROM musecity.proposals p JOIN musecity.accounts a ON a.id=p.owner_account_id
    WHERE ($1::timestamptz IS NULL OR (p.created_at,p.id)<($1,$3)) AND ${visible}
    ORDER BY p.created_at DESC,p.id DESC LIMIT 21`,
    [cursor?.time ?? null, viewer?.account.id ?? null, cursor?.id ?? null],
  );
  const items = [];
  for (const r of rows) items.push(await proposalView(db, r.id, viewer));
  return page(items, filter, (p) => p.createdAt);
}
export async function createProposal(
  db: Database,
  a: Actor,
  services: WalletServices | undefined,
  content: { title: string; body: string },
) {
  const member = await membership(db, a, services);
  requireValue(
    member.formalMember,
    403,
    "MEMBERSHIP_REQUIRED",
    "Hold at least 100,000 MUSEGOD in your musegod.ai wallet on Robinhood Chain to publish a proposal.",
  );
  await dailyBudget(db, a, "publication");
  const proposalId = id("prp");
  await db.query(
    `INSERT INTO musecity.proposals(id,owner_account_id,title,body,rules,created_at,starts_at,ends_at)
    SELECT $1,$2,$3,$4,$5,t,t+interval '24 hours',t+interval '96 hours' FROM (SELECT clock_timestamp() AS t) clock`,
    [
      proposalId,
      a.account.id,
      content.title,
      content.body,
      JSON.stringify(governanceRules),
    ],
  );
  await audit(db, a, "proposal.create", proposalId);
  return proposalId;
}
export async function vote(
  db: Database,
  a: Actor,
  services: WalletServices | undefined,
  proposalId: string,
  choice: VoteChoice,
) {
  const p = await lockedProposal(db, proposalId, a);
  requireValue(
    !p.cancelled_at,
    409,
    "PROPOSAL_CANCELLED",
    "This proposal was cancelled.",
  );
  const open = () =>
    db.one("SELECT 1 WHERE clock_timestamp()>=$1 AND clock_timestamp()<$2", [
      p.starts_at,
      p.ends_at,
    ]);
  requireValue(
    await open(),
    409,
    "VOTING_CLOSED",
    "Voting has not started or has ended.",
  );
  const member = await membership(db, a, services, p.rules);
  // The balance lookup can span the deadline. Check the database wall clock at
  // the actual write, not now() (the transaction's possibly much earlier start).
  const saved = await db.one(
    `INSERT INTO musecity.proposal_votes(proposal_id,account_id,choice,weight,checked_at,wallet_address,balance)
    SELECT $1,$2,$3,$4,$5,$6,$7 WHERE clock_timestamp()>=$8 AND clock_timestamp()<$9
    ON CONFLICT(proposal_id,account_id) DO UPDATE SET choice=EXCLUDED.choice,weight=EXCLUDED.weight,checked_at=EXCLUDED.checked_at,wallet_address=EXCLUDED.wallet_address,balance=EXCLUDED.balance
    RETURNING proposal_id`,
    [
      proposalId,
      a.account.id,
      choice,
      member.weight,
      member.checkedAt,
      member.wallet?.address ?? null,
      member.balance,
      p.starts_at,
      p.ends_at,
    ],
  );
  requireValue(
    saved,
    409,
    "VOTING_CLOSED",
    "Voting ended while checking your balance. Your previous vote has not changed.",
  );
  await audit(db, a, "proposal.vote", proposalId);
  return { saved: true };
}
export async function cancelProposal(
  db: Database,
  a: Actor,
  proposalId: string,
  reason: string,
) {
  await lockedProposal(db, proposalId, a);
  requireValue(
    (await proposalView(db, proposalId, a)).canCancel,
    409,
    "CANCELLATION_DENIED",
    "Only the author or an operator can cancel an open proposal.",
  );
  const saved = await db.one(
    `UPDATE musecity.proposals SET cancelled_at=clock_timestamp(),cancelled_by=$2,cancellation_reason=$3
    WHERE id=$1 AND cancelled_at IS NULL AND ends_at>clock_timestamp() RETURNING id`,
    [proposalId, a.account.id, reason],
  );
  requireValue(saved, 409, "VOTING_CLOSED", "This proposal has already ended.");
  await audit(db, a, "proposal.cancel", proposalId);
  return { saved: true };
}
export async function recordExecution(
  db: Database,
  a: Actor,
  proposalId: string,
  result: string,
) {
  await lockedProposal(db, proposalId, a);
  requireValue(
    await moderator(db, a),
    403,
    "SCOPE_DENIED",
    "Moderator access is required.",
  );
  requireValue(
    (await proposalView(db, proposalId, a)).canRecordExecution,
    409,
    "EXECUTION_DENIED",
    "Only passed proposals without an execution record can be recorded.",
  );
  await db.query(
    "UPDATE musecity.proposals SET execution_result=$2,executed_at=clock_timestamp(),executed_by=$3 WHERE id=$1",
    [proposalId, result, a.account.id],
  );
  await audit(db, a, "proposal.execution", proposalId);
  return { saved: true };
}
