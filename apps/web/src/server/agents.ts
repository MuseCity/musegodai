import type { Database } from "./database";
import { audit, type Actor } from "./auth";
import { requireValue } from "./errors";
import { id, secret, digest, future } from "./crypto";
import { type Scope, type AgentView } from "../shared/contracts";
import type { AgentRow } from "./schema";
type Registration = {
  id: string;
  name: string;
  requested_scopes: Scope[];
  approved_scopes: Scope[] | null;
  owner_account_id: string | null;
  status: string;
  expires_at: Date;
  agent_id: string | null;
};
const expirySeconds = 86400;
export const agentView = (a: AgentRow): AgentView => ({
  id: a.id,
  name: a.name,
  scopes: a.scopes,
  status: a.status as AgentView["status"],
  createdAt: a.created_at.toISOString(),
  lastActiveAt: a.last_active_at?.toISOString() ?? null,
  publicVisible: a.public_visible,
  description: a.description,
});
export async function invite(
  db: Database,
  a: Actor,
  name: string,
  scopes: Scope[],
) {
  const invitationId = id("inv");
  const token = secret("mci");
  const expiresAt = future(expirySeconds);
  await db.query(
    "INSERT INTO musecity.invitations(id,owner_account_id,name,scopes,token_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6)",
    [
      invitationId,
      a.account.id,
      name,
      JSON.stringify(scopes),
      await digest(token),
      expiresAt,
    ],
  );
  await audit(db, a, "invitation.create", invitationId);
  return { invitationId, invitationToken: token, expiresAt };
}
export async function register(
  db: Database,
  name: string,
  requested: Scope[],
  invitationToken?: string,
) {
  let owner: string | null = null;
  if (invitationToken) {
    const inv = await db.one<{
      id: string;
      owner_account_id: string;
      name: string;
      scopes: Scope[];
      expires_at: Date;
      used_at: Date | null;
      cancelled_at: Date | null;
    }>("SELECT * FROM musecity.invitations WHERE token_hash=$1 FOR UPDATE", [
      await digest(invitationToken),
    ]);
    requireValue(inv, 401, "INVALID_CREDENTIAL", "Invalid invitation.");
    requireValue(
      !inv.used_at && !inv.cancelled_at,
      409,
      "INVITATION_USED",
      "This invitation was used or cancelled.",
    );
    requireValue(
      inv.expires_at > new Date(),
      410,
      "INVITATION_EXPIRED",
      "This invitation has expired.",
    );
    requireValue(
      requested.every((s) => inv.scopes.includes(s)),
      422,
      "INVITATION_SCOPE_EXCEEDED",
      "Requested permissions exceed the invitation.",
    );
    owner = inv.owner_account_id;
    name = inv.name;
    await db.query(
      "UPDATE musecity.invitations SET used_at=now() WHERE id=$1",
      [inv.id],
    );
  }
  const registrationId = id("reg");
  const token = secret("mcr");
  const claim = owner ? null : secret("mcc");
  const expiresAt = future(expirySeconds);
  await db.query(
    "INSERT INTO musecity.registrations(id,name,requested_scopes,approved_scopes,owner_account_id,token_hash,claim_hash,status,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [
      registrationId,
      name,
      JSON.stringify(requested),
      owner ? JSON.stringify(requested) : null,
      owner,
      await digest(token),
      claim ? await digest(claim) : null,
      owner ? "approved" : "pending_claim",
      expiresAt,
    ],
  );
  return {
    registrationId,
    registrationToken: token,
    status: owner ? "approved" : "pending_claim",
    claimPath: claim ? "/agents/claim#token=" + claim : null,
    expiresAt,
    pollAfterSeconds: 5,
  };
}
async function registration(
  db: Database,
  registrationId: string,
  token: string,
) {
  const r = await db.one<Registration>(
    "SELECT * FROM musecity.registrations WHERE id=$1 AND token_hash=$2 FOR UPDATE",
    [registrationId, await digest(token)],
  );
  requireValue(
    r,
    401,
    "INVALID_CREDENTIAL",
    "Invalid registration credential.",
  );
  requireValue(
    r.expires_at > new Date(),
    410,
    "REGISTRATION_EXPIRED",
    "This registration expired.",
  );
  return r;
}
export async function registrationStatus(
  db: Database,
  registrationId: string,
  token: string,
) {
  const r = await registration(db, registrationId, token);
  return {
    registrationId: r.id,
    status: r.status,
    approvedScopes: r.approved_scopes,
    expiresAt: r.expires_at,
    agentId: r.agent_id,
    pollAfterSeconds: 5,
  };
}
export async function claimPreview(db: Database, claimToken: string) {
  const r = await db.one<Registration>(
    "SELECT * FROM musecity.registrations WHERE claim_hash=$1",
    [await digest(claimToken)],
  );
  requireValue(r, 404, "NOT_FOUND", "This claim link is invalid.");
  requireValue(
    r.expires_at > new Date(),
    410,
    "REGISTRATION_EXPIRED",
    "This claim link expired.",
  );
  requireValue(
    r.status === "pending_claim",
    409,
    "CLAIM_ALREADY_USED",
    "This request has already been claimed.",
  );
  return {
    registrationId: r.id,
    name: r.name,
    requestedScopes: r.requested_scopes,
    expiresAt: r.expires_at,
  };
}
export async function claim(
  db: Database,
  a: Actor,
  registrationId: string,
  claimToken: string,
  approved: Scope[],
) {
  const r = await db.one<Registration>(
    "SELECT * FROM musecity.registrations WHERE id=$1 AND claim_hash=$2 FOR UPDATE",
    [registrationId, await digest(claimToken)],
  );
  requireValue(r, 404, "NOT_FOUND", "Claim not found.");
  requireValue(
    r.status === "pending_claim",
    409,
    "CLAIM_ALREADY_USED",
    "This request has already been claimed.",
  );
  requireValue(
    r.expires_at > new Date(),
    410,
    "REGISTRATION_EXPIRED",
    "This request expired.",
  );
  requireValue(
    approved.every((s) => r.requested_scopes.includes(s)),
    422,
    "INVALID_SCOPE_COMBINATION",
    "Approve only requested permissions.",
  );
  await db.query(
    "UPDATE musecity.registrations SET owner_account_id=$2,approved_scopes=$3,status='approved' WHERE id=$1",
    [registrationId, a.account.id, JSON.stringify(approved)],
  );
  await audit(db, a, "registration.claim", registrationId);
  return { registrationId, status: "approved" };
}
export async function issueCredential(db: Database, agentId: string) {
  const token = secret("mca");
  const expiresAt = future(90 * 86400);
  await db.query(
    "INSERT INTO musecity.credentials(id,agent_id,token_hash,prefix,expires_at) VALUES($1,$2,$3,$4,$5)",
    [id("cred"), agentId, await digest(token), token.slice(0, 12), expiresAt],
  );
  return { token, expiresAt };
}
export async function activate(
  db: Database,
  registrationId: string,
  token: string,
) {
  // Discover owner without a row lock; lock account before registration, matching claim/cancel.
  const hint = await db.one<Registration>(
    "SELECT * FROM musecity.registrations WHERE id=$1 AND token_hash=$2",
    [registrationId, await digest(token)],
  );
  requireValue(
    hint?.owner_account_id,
    403,
    "AGENT_UNCLAIMED",
    "An owner must approve this registration.",
  );
  const owner = await db.one<{ status: string }>(
    "SELECT status FROM musecity.accounts WHERE id=$1 FOR UPDATE",
    [hint.owner_account_id],
  );
  requireValue(
    owner?.status === "active",
    403,
    "ACCOUNT_RESTRICTED",
    "The owner account is restricted.",
  );
  const r = await registration(db, registrationId, token);
  requireValue(
    r.status !== "activated",
    409,
    "ACTIVATION_ALREADY_COMPLETED",
    "Already activated. Ask your owner to rotate the credential if it was lost.",
  );
  requireValue(
    r.status === "approved",
    403,
    "AGENT_UNCLAIMED",
    "The owner has not approved this registration.",
  );
  const count = await db.one<{ n: string }>(
    "SELECT count(*) AS n FROM musecity.agents WHERE owner_account_id=$1 AND status<>'revoked'",
    [r.owner_account_id],
  );
  requireValue(
    Number(count?.n) < 20,
    409,
    "AGENT_LIMIT",
    "This account has reached its 20-agent limit.",
  );
  const agentId = id("agt");
  await db.query(
    "INSERT INTO musecity.agents(id,owner_account_id,name,scopes) VALUES($1,$2,$3,$4)",
    [agentId, r.owner_account_id, r.name, JSON.stringify(r.approved_scopes)],
  );
  const credential = await issueCredential(db, agentId);
  await db.query(
    "UPDATE musecity.registrations SET status='activated',agent_id=$2 WHERE id=$1",
    [registrationId, agentId],
  );
  return {
    agentId,
    ownerAccountId: r.owner_account_id,
    status: "active",
    scopes: r.approved_scopes,
    credential,
  };
}
export async function ownAgent(db: Database, a: Actor, agentId: string) {
  const agent = await db.one<AgentRow>(
    "SELECT * FROM musecity.agents WHERE id=$1 AND owner_account_id=$2 FOR UPDATE",
    [agentId, a.account.id],
  );
  requireValue(agent, 404, "NOT_FOUND", "Agent not found.");
  return agent;
}
export async function changeAgent(
  db: Database,
  a: Actor,
  agentId: string,
  action: string,
  input?: {
    name?: string;
    scopes?: Scope[];
    publicVisible?: boolean;
    description?: string;
  },
) {
  const agent = await ownAgent(db, a, agentId);
  requireValue(
    agent.status !== "revoked",
    409,
    "AGENT_REVOKED",
    "Revocation is permanent. Create a new invitation.",
  );
  if (action === "edit")
    await db.query(
      "UPDATE musecity.agents SET name=$2,scopes=$3,public_visible=$4,description=$5 WHERE id=$1",
      [
        agentId,
        input?.name ?? agent.name,
        JSON.stringify(input?.scopes ?? agent.scopes),
        input?.publicVisible ?? agent.public_visible,
        input?.description ?? agent.description,
      ],
    );
  else if (["pause", "resume", "revoke"].includes(action))
    await db.query("UPDATE musecity.agents SET status=$2 WHERE id=$1", [
      agentId,
      (
        { pause: "paused", resume: "active", revoke: "revoked" } as Record<
          string,
          string
        >
      )[action],
    ]);
  if (["revoke", "rotate"].includes(action)) {
    await db.query(
      "UPDATE musecity.credentials SET revoked_at=now() WHERE agent_id=$1 AND revoked_at IS NULL",
      [agentId],
    );
    await db.query(
      "UPDATE musecity.oauth_grants SET revoked_at=now() WHERE agent_id=$1",
      [agentId],
    );
  }
  await audit(db, a, "agent." + action, agentId);
  const oauthAgent = await db.one<{ id: string }>(
    "SELECT id FROM musecity.oauth_grants WHERE agent_id=$1",
    [agentId],
  );
  if (
    oauthAgent &&
    (["revoke", "rotate"].includes(action) ||
      (action === "edit" && input?.scopes))
  )
    await db.query(
      `UPDATE musecity.oauth_requests r SET status='denied' WHERE r.status='approved' AND EXISTS(
      SELECT 1 FROM musecity.oauth_grants g WHERE g.agent_id=$1 AND g.owner_account_id=r.owner_account_id AND g.client_id=r.client_id)`,
      [agentId],
    );
  return action === "rotate" && !oauthAgent
    ? { agentId, credential: await issueCredential(db, agentId) }
    : {
        ...agentView(await ownAgent(db, a, agentId)),
        ...(action === "rotate" && oauthAgent
          ? { reconnectRequired: true }
          : {}),
      };
}
