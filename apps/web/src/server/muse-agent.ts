import {
  placePageValid,
  type AgentMuseView,
  type MuseReport,
} from "../shared/muses";
import { audit, type Actor } from "./auth";
import type { Database } from "./database";
import { requireValue } from "./errors";
import { publicMuse, type MuseDeps } from "./muses";
import type { MuseBindingRow, MuseReportRow } from "./schema";

// actor() already holds the account lock. Report and relay mutations then lock
// the binding before its signatures, keeping replacement and sending ordered.
export async function requireMuseAgent(
  db: Database,
  deps: MuseDeps,
  a: Actor,
  lock = false,
): Promise<MuseBindingRow> {
  requireValue(
    a.agent,
    403,
    "MUSE_NOT_BOUND",
    "This Agent is not bound to a muse.",
  );
  const binding = await db.one<MuseBindingRow>(
    "SELECT * FROM musecity.muse_bindings WHERE agent_id=$1 AND account_id=$2 AND ended_at IS NULL" +
      (lock ? " FOR UPDATE" : ""),
    [a.agent.id, a.account.id],
  );
  requireValue(
    binding,
    403,
    "MUSE_NOT_BOUND",
    "This Agent is not bound to a muse.",
  );
  const linked = [
    ...new Set(await deps.wallets.linkedAddresses(a.account.privy_user_id)),
  ];
  const controllers = await Promise.all(
    linked.map((address) =>
      deps.chain.isController(binding.agent_id_8004, address),
    ),
  );
  requireValue(
    controllers.some(Boolean),
    403,
    "NOT_MUSE_KEEPER",
    "None of your linked wallets controls this muse.",
  );
  return binding;
}

export async function agentMuse(
  db: Database,
  deps: MuseDeps,
  a: Actor,
): Promise<AgentMuseView> {
  const binding = await requireMuseAgent(db, deps, a);
  // Public reads may end a transferred binding and take its registration lock.
  // Do not hold a binding row lock before that existing cleanup path.
  const view = await publicMuse(db, deps, String(binding.token_id));
  requireValue(
    await db.one(
      "SELECT id FROM musecity.muse_bindings WHERE id=$1 AND ended_at IS NULL",
      [binding.id],
    ),
    403,
    "MUSE_NOT_BOUND",
    "This Agent is not bound to a muse.",
  );
  const signatures = await db.query<{
    founding: number;
    address: string;
    signature: string;
  }>(
    `SELECT r.founding_number AS founding,s.signer AS address,s.signature
     FROM musecity.muse_signatures s JOIN musecity.muse_reports r ON r.binding_id=s.binding_id AND r.step='flock'
     WHERE s.binding_id=$1 AND s.kind='flock_claim' AND s.place='flock'
       AND s.state='handed_to_agent' AND r.founding_number IS NOT NULL
     ORDER BY s.created_at,s.id`,
    [binding.id],
  );
  return {
    id: binding.token_id,
    name: view.muse.name,
    page: `${deps.origin}/muses/${binding.token_id}`,
    steps: view.steps,
    next:
      view.steps.find(
        (step) => step.status !== "done" && step.status !== "skipped",
      )?.id ?? null,
    signatures: signatures.map((signature) => ({
      kind: "flock_claim",
      ...signature,
    })),
  };
}

export async function reportMuseStep(
  db: Database,
  deps: MuseDeps,
  a: Actor,
  body: MuseReport,
): Promise<{ accepted: true }> {
  const binding = await requireMuseAgent(db, deps, a, true);
  if (body.url !== undefined)
    requireValue(
      body.step !== "soul" &&
        body.step !== "look" &&
        body.step !== "flock" &&
        placePageValid(body.step, body.url),
      400,
      "invalid_place_url",
      "Use this place's public profile URL.",
    );
  if (body.founding_number !== undefined) {
    const [record, founding] = await Promise.all([
      deps.musegod.muse(binding.token_id),
      deps.musegod.founding(body.founding_number),
    ]);
    requireValue(
      body.step === "flock" &&
        founding?.name.toLowerCase() === record.value.name.toLowerCase(),
      400,
      "invalid_founding_number",
      "The founding profile must carry this muse's name.",
    );
  }
  const previous = await db.one<MuseReportRow>(
    "SELECT * FROM musecity.muse_reports WHERE binding_id=$1 AND step=$2",
    [binding.id, body.step],
  );
  const url = body.url ?? previous?.url ?? null,
    founding = body.founding_number ?? previous?.founding_number ?? null;
  if (
    body.step !== "soul" &&
    body.step !== "look" &&
    ((body.url != null && previous?.url !== body.url) ||
      (body.founding_number != null &&
        previous?.founding_number !== body.founding_number))
  )
    await db.query(
      "UPDATE musecity.muse_signatures SET state='superseded' WHERE binding_id=$1 AND place=$2 AND state IN ('queued','sent','handed_to_agent')",
      [binding.id, body.step],
    );
  await db.query(
    `INSERT INTO musecity.muse_reports(binding_id,step,status,url,founding_number,wallet_address,code)
     VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(binding_id,step) DO UPDATE
     SET status=EXCLUDED.status,url=EXCLUDED.url,founding_number=EXCLUDED.founding_number,
       wallet_address=EXCLUDED.wallet_address,code=EXCLUDED.code,reported_at=now()`,
    [
      binding.id,
      body.step,
      body.status,
      url,
      founding,
      body.wallet_address ?? null,
      body.code ?? null,
    ],
  );
  await audit(db, a, "muse.report", binding.id);
  return { accepted: true };
}
