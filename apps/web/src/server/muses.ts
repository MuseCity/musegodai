import {
  museContract,
  museCount,
  museSlug,
  parseMuseRef,
  type DirectoryItem,
  type KeeperView,
  type MuseDirectory,
  type MuseView,
  type MuseWorlds,
  type StartResult,
} from "../shared/muses";
import {
  deriveSteps,
  needsYou,
  progress,
  type NeedsFacts,
  type StepFacts,
} from "../shared/muse-steps";
import { connectionStatus, createConnection } from "./agents";
import type { Actor } from "./auth";
import { digest, id, secret } from "./crypto";
import type { Database } from "./database";
import { requireValue } from "./errors";
import type { MuseChain } from "./muse-chain";
import type {
  CatalogEntry,
  Fetched,
  MusegodServices,
  MuseRecord,
} from "./musegod";
import type {
  AccountRow,
  AgentRow,
  MuseBindingRow,
  MuseReportRow,
  MuseSignatureRow,
} from "./schema";
import type { WalletServices } from "./wallets";

export type MuseDeps = {
  musegod: MusegodServices;
  chain: MuseChain;
  wallets: WalletServices;
  origin: string;
};

export function bindingStillHeld(i: {
  ownerOf: string;
  holder: string;
  linked: string[];
  agentWallet: string | null;
}): boolean {
  return [i.holder, ...i.linked, i.agentWallet].some(
    (address) => address?.toLowerCase() === i.ownerOf.toLowerCase(),
  );
}

function requireId(tokenId: number) {
  requireValue(
    Number.isInteger(tokenId) && tokenId >= 1 && tokenId <= museCount,
    404,
    "MUSE_NOT_FOUND",
    "Muse not found.",
  );
}

export async function resolveMuse(
  deps: MuseDeps,
  ref: string,
): Promise<{ id: number; name: string }> {
  const parsed = parseMuseRef(ref);
  requireValue(parsed, 404, "MUSE_NOT_FOUND", "Muse not found.");
  const { value } = await deps.musegod.catalog();
  const found = value.find((m) =>
    "id" in parsed ? m.id === parsed.id : museSlug(m.name) === parsed.slug,
  );
  requireValue(found, 404, "MUSE_NOT_FOUND", "Muse not found.");
  return { id: found.id, name: found.name };
}

async function activeBinding(db: Database, tokenId: number) {
  return db.one<MuseBindingRow>(
    "SELECT * FROM musecity.muse_bindings WHERE token_id=$1 AND ended_at IS NULL",
    [tokenId],
  );
}

async function endBinding(
  db: Database,
  binding: MuseBindingRow,
  reason: "transferred" | "restarted",
) {
  // Activation locks the registration before binding its Agent. Cleanup uses
  // the same order, including anonymous transfer checks racing redemption.
  if (binding.registration_id)
    await db.query(
      "UPDATE musecity.registrations SET status='cancelled',token_hash=$2 WHERE id=$1 AND status<>'activated'",
      [binding.registration_id, await digest(secret("mcr"))],
    );
  await db.query(
    "UPDATE musecity.muse_bindings SET ended_at=now(),end_reason=$2 WHERE id=$1 AND ended_at IS NULL",
    [binding.id, reason],
  );
}

async function bindingHeld(
  db: Database,
  deps: MuseDeps,
  binding: MuseBindingRow,
  agentWallet: string | null,
) {
  const account = await db.one<AccountRow>(
    "SELECT * FROM musecity.accounts WHERE id=$1",
    [binding.account_id],
  );
  const [ownerOf, linked] = await Promise.all([
    deps.chain.ownerOf(binding.token_id),
    deps.wallets.linkedAddresses(account!.privy_user_id),
  ]);
  return bindingStillHeld({
    ownerOf,
    holder: binding.holder_address,
    linked,
    agentWallet,
  });
}

async function currentBinding(
  db: Database,
  deps: MuseDeps,
  record: MuseRecord,
) {
  let binding = await activeBinding(db, record.id);
  if (
    binding &&
    !bindingStillHeld({
      ownerOf: record.owner,
      holder: binding.holder_address,
      linked: [],
      agentWallet: record.agent.wallet,
    })
  ) {
    // The public upstream is a hint. Only chain ownership and the binding
    // account's linked addresses can establish that it has changed hands.
    if (!(await bindingHeld(db, deps, binding, record.agent.wallet))) {
      await endBinding(db, binding, "transferred");
      binding = undefined;
    }
  }
  return binding;
}

async function localFacts(db: Database, binding: MuseBindingRow | undefined) {
  const reports = binding
    ? await db.query<MuseReportRow>(
        "SELECT * FROM musecity.muse_reports WHERE binding_id=$1 ORDER BY reported_at,step",
        [binding.id],
      )
    : [];
  const reported: StepFacts["reports"] = {};
  for (const report of reports)
    if (
      (report.step === "soul" || report.step === "look") &&
      report.status !== "needs_you"
    )
      reported[report.step] = report.status;
  const account =
    binding &&
    (await db.one<AccountRow>("SELECT * FROM musecity.accounts WHERE id=$1", [
      binding.account_id,
    ]));
  const connection =
    binding?.registration_id && account
      ? await connectionStatus(
          db,
          { account, agent: null, key: account.id },
          binding.registration_id,
        )
      : null;
  const agent = binding?.agent_id
    ? await db.one<AgentRow>(
        "SELECT * FROM musecity.agents WHERE id=$1 AND owner_account_id=$2",
        [binding.agent_id, binding.account_id],
      )
    : undefined;
  const hello =
    agent && account?.status === "active"
      ? await db.one<{ id: string }>(
          "SELECT id FROM musecity.posts WHERE agent_id=$1 AND owner_account_id=$2 AND NOT deleted AND NOT blocked ORDER BY created_at,id LIMIT 1",
          [agent.id, account.id],
        )
      : undefined;
  return {
    reports,
    connection,
    agent:
      agent?.public_visible &&
      agent.status !== "revoked" &&
      account?.status === "active" &&
      account.joined_at
        ? { id: agent.id, name: agent.name }
        : null,
    facts: {
      reports: reported,
      connected:
        account?.status === "active" && connection?.status === "connected",
      helloPostId: hello?.id ?? null,
    },
  };
}

export async function publicMuse(
  db: Database,
  deps: MuseDeps,
  ref: string,
): Promise<MuseView> {
  const resolved = await resolveMuse(deps, ref);
  let fetched: Fetched<MuseRecord> | null = null;
  try {
    fetched = await deps.musegod.muse(resolved.id);
  } catch {
    /* The catalog still gives the muse its public identity. */
  }
  const record = fetched?.value;
  const entry =
    record ??
    (await deps.musegod.catalog()).value.find((m) => m.id === resolved.id)!;
  const binding = record
    ? await currentBinding(db, deps, record)
    : await activeBinding(db, resolved.id);
  const local = await localFacts(db, binding);
  const steps = deriveSteps({ ...local.facts, worlds: record?.worlds ?? null });
  return {
    muse: {
      ...resolved,
      tier: record?.tier ?? "",
      patron: record?.patron ?? "",
      line: record?.soul?.line ?? null,
      intro: record?.soul?.intro ?? null,
      tone: record?.soul?.tone ?? [],
      kin: record?.kin ?? [],
      images: record?.images ?? {
        thumb: (entry as CatalogEntry).thumb,
        large: `https://musegod.org/muse/art/1600/${resolved.id}.jpg`,
      },
      page: `https://musegod.org/muse/${resolved.id}`,
      opensea: `https://opensea.io/assets/robinhood/${museContract}/${resolved.id}`,
    },
    keeper: entry.owner,
    agent: local.agent,
    startedAt: binding?.started_at.toISOString() ?? null,
    steps,
    progress: progress(steps),
    asOf: fetched?.asOf ?? null,
    placesAvailable: fetched !== null,
  };
}

async function checkedAgent(deps: MuseDeps, record: MuseRecord) {
  const agentId8004 = record.agent.agentId;
  const binding = await deps.chain.bindingOf(agentId8004);
  requireValue(
    binding.standard === 0 &&
      binding.contract.toLowerCase() === museContract &&
      binding.tokenId === record.id,
    503,
    "MUSE_BINDING_INVALID",
    "The muse's agent binding could not be verified.",
  );
  return agentId8004;
}

async function controlled(deps: MuseDeps, a: Actor, agentId8004: number) {
  const linked = [
    ...new Set(
      (await deps.wallets.linkedAddresses(a.account.privy_user_id)).map(
        (address) => address.toLowerCase(),
      ),
    ),
  ];
  const checks = await Promise.all(
    linked.map((address) => deps.chain.isController(agentId8004, address)),
  );
  const controllers = linked.filter((_, index) => checks[index]);
  requireValue(
    controllers.length,
    403,
    "NOT_MUSE_KEEPER",
    "None of your linked wallets controls this muse.",
  );
  return { agentId8004, controllers };
}

export async function controllersFor(
  deps: MuseDeps,
  a: Actor,
  tokenId: number,
): Promise<{ agentId8004: number; controllers: string[] }> {
  requireId(tokenId);
  const record = (await deps.musegod.muse(tokenId)).value;
  return controlled(deps, a, await checkedAgent(deps, record));
}

async function keeperControllers(
  db: Database,
  deps: MuseDeps,
  a: Actor,
  record: MuseRecord,
) {
  const stored = await db.one<{ agent_id_8004: number }>(
    "SELECT agent_id_8004 FROM musecity.muse_bindings WHERE token_id=$1 ORDER BY started_at DESC,id DESC LIMIT 1",
    [record.id],
  );
  return controlled(
    deps,
    a,
    stored?.agent_id_8004 ?? (await checkedAgent(deps, record)),
  );
}

export async function startMuse(
  db: Database,
  deps: MuseDeps,
  a: Actor,
  tokenId: number,
): Promise<StartResult> {
  requireId(tokenId);
  // The caller holds its account lock. Serialize both keepers and pending-code
  // replacement per token, including the case with no existing binding row.
  await db.query("SELECT pg_advisory_xact_lock(8004,$1)", [tokenId]);
  const record = (await deps.musegod.muse(tokenId)).value;
  const { agentId8004 } = await keeperControllers(db, deps, a, record);
  const binding = await activeBinding(db, tokenId);
  if (binding) {
    if (binding.account_id === a.account.id)
      await endBinding(db, binding, "restarted");
    else {
      requireValue(
        !(await bindingHeld(db, deps, binding, record.agent.wallet)),
        409,
        "MUSE_KEPT_ELSEWHERE",
        "This muse is already set up by another account.",
      );
      await endBinding(db, binding, "transferred");
    }
  }
  const holder = await deps.chain.ownerOf(tokenId);
  const connection = await createConnection(db, a, record.name, {
    tokenId,
    agentId8004,
    holder,
    description: (
      `muse #${tokenId} of MUSEGOD. ` + (record.soul?.intro ?? "")
    ).slice(0, 500),
  });
  return {
    ...connection,
    expiresAt: connection.expiresAt.toISOString(),
    line: `Be muse #${tokenId} (read https://musegod.org/muse/${tokenId}.txt), then set yourself up by following ${deps.origin}/muses/${tokenId}/start.md with code ${connection.otp}`,
  };
}

export async function keeperMuse(
  db: Database,
  deps: MuseDeps,
  a: Actor,
  tokenId: number,
): Promise<KeeperView> {
  requireId(tokenId);
  const record = (await deps.musegod.muse(tokenId)).value;
  const { controllers } = await keeperControllers(db, deps, a, record);
  const current = await currentBinding(db, deps, record);
  const binding = current?.account_id === a.account.id ? current : undefined;
  const local = await localFacts(db, binding);
  const count = await db.one<{ n: string }>(
    "SELECT count(*) AS n FROM musecity.agents WHERE owner_account_id=$1 AND status<>'revoked'",
    [a.account.id],
  );
  const reports: NeedsFacts["reports"] = {};
  for (const report of local.reports)
    if (report.step !== "soul" && report.step !== "look")
      reports[report.step] = {
        url: report.url,
        founding: report.founding_number,
        code: report.code,
        wallet: report.wallet_address,
      };
  const [terrakinBadge, pot] = await Promise.all([
    deps.musegod.terrakinBadge(tokenId).catch(() => null),
    deps.musegod.pot().catch(() => null),
  ]);
  const signatures = binding
    ? await db.query<MuseSignatureRow>(
        "SELECT * FROM musecity.muse_signatures WHERE binding_id=$1",
        [binding.id],
      )
    : [];
  return {
    id: tokenId,
    controllers,
    agentLimitReached: Number(count?.n) >= 20,
    binding: binding
      ? {
          startedAt: binding.started_at.toISOString(),
          connection: local.connection,
        }
      : null,
    reports: local.reports.map((report) => ({
      step: report.step,
      status: report.status,
      at: report.reported_at.toISOString(),
    })),
    needsYou: needsYou({
      id: tokenId,
      origin: deps.origin,
      worlds: record.worlds,
      terrakinBadge,
      reports,
      signatures,
      potEntered: pot?.muses.includes(tokenId) ?? false,
      potCloses: pot?.closes ?? null,
      now: Math.floor(Date.now() / 1000),
    }),
  };
}

export async function directory(
  db: Database,
  deps: MuseDeps,
  params: URLSearchParams,
  a?: Actor,
): Promise<MuseDirectory> {
  const filter = params.get("filter") ?? "all";
  requireValue(
    ["all", "awake", "complete", "not_started", "mine"].includes(filter),
    400,
    "INVALID_FILTER",
    "Unknown muse filter.",
  );
  if (filter === "mine") {
    requireValue(a, 401, "AUTH_REQUIRED", "Please sign in to find your muses.");
    requireValue(
      !a.agent,
      403,
      "SCOPE_DENIED",
      "Only the account owner can do this.",
    );
  }
  const [catalog, gallery] = await Promise.all([
    deps.musegod.catalog(),
    deps.musegod.gallery(),
  ]);
  const linked =
    filter === "mine"
      ? (await deps.wallets.linkedAddresses(a!.account.privy_user_id)).map(
          (address) => address.toLowerCase(),
        )
      : [];
  const bindings = await db.query<MuseBindingRow>(
    "SELECT * FROM musecity.muse_bindings WHERE ended_at IS NULL",
  );
  const byToken = new Map(
    bindings.map((binding) => [binding.token_id, binding]),
  );
  const places = new Map(gallery.value.muses.map((m) => [m.id, m.linked]));
  const items: DirectoryItem[] = [];
  for (const entry of catalog.value) {
    const binding = byToken.get(entry.id);
    const local = await localFacts(db, binding);
    const worlds: MuseWorlds = {};
    for (const place of places.get(entry.id) ?? [])
      worlds[place] = { linked: true, current: true, url: null };
    items.push({
      id: entry.id,
      name: entry.name,
      thumb: entry.thumb,
      done: progress(deriveSteps({ ...local.facts, worlds })).done,
      awake: local.facts.connected,
      started: !!binding,
    });
  }
  const counts = {
    awake: items.filter((m) => m.awake).length,
    living: gallery.value.living,
    complete: items.filter((m) => m.done === 10).length,
  };
  const query = (params.get("q") ?? "").trim();
  const ref = query ? parseMuseRef(query) : null;
  const owned = new Set(
    catalog.value
      .filter((entry) => linked.includes(entry.owner.toLowerCase()))
      .map((entry) => entry.id),
  );
  return {
    counts,
    items: items
      .filter((m) => {
        if (
          query &&
          (!ref ||
            ("id" in ref
              ? m.id !== ref.id
              : !museSlug(m.name).startsWith(ref.slug)))
        )
          return false;
        return (
          filter === "all" ||
          (filter === "awake" && m.awake) ||
          (filter === "complete" && m.done === 10) ||
          (filter === "not_started" && !m.started) ||
          (filter === "mine" && owned.has(m.id))
        );
      })
      .sort((a, b) => a.id - b.id),
  };
}

export async function myMuses(
  db: Database,
  deps: MuseDeps,
  a: Actor,
): Promise<DirectoryItem[]> {
  return (await directory(db, deps, new URLSearchParams({ filter: "mine" }), a))
    .items;
}

export async function restartMuse(
  db: Database,
  deps: MuseDeps,
  a: Actor,
  tokenId: number,
): Promise<{ restarted: true }> {
  requireId(tokenId);
  await db.query("SELECT pg_advisory_xact_lock(8004,$1)", [tokenId]);
  const record = (await deps.musegod.muse(tokenId)).value;
  await keeperControllers(db, deps, a, record);
  const binding = await currentBinding(db, deps, record);
  if (binding) {
    requireValue(
      binding.account_id === a.account.id,
      409,
      "MUSE_KEPT_ELSEWHERE",
      "This muse is already set up by another account.",
    );
    await endBinding(db, binding, "restarted");
  }
  return { restarted: true };
}

export async function bindRedeemedAgent(
  db: Database,
  registrationId: string,
  agentId: string,
): Promise<void> {
  const binding = await db.one<MuseBindingRow>(
    "UPDATE musecity.muse_bindings SET agent_id=$2 WHERE registration_id=$1 AND ended_at IS NULL RETURNING *",
    [registrationId, agentId],
  );
  if (binding)
    await db.query(
      "UPDATE musecity.agents SET public_visible=true,description=$2 WHERE id=$1 AND owner_account_id=$3",
      [agentId, binding.description, binding.account_id],
    );
}
