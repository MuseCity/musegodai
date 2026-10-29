import { recoverMessageAddress } from "viem";
import {
  elsewhereLine,
  flockClaimLine,
  livesAtLine,
  museLinkLine,
  placePageValid,
  type MuseSignature,
  type PlaceId,
  type SignatureKind,
} from "../shared/muses";
import { rateLimit, type Actor } from "./auth";
import { id } from "./crypto";
import { withDatabase, type Database } from "./database";
import { ApiError, requireValue } from "./errors";
import { endIfTransferred, keeperMuse, type MuseDeps } from "./muses";
import type { MuseBindingRow, MuseReportRow, MuseSignatureRow } from "./schema";

function withinWindow(at: number | null): boolean {
  const now = Math.floor(Date.now() / 1000);
  return at !== null && now - 600 <= at && at <= now + 30;
}

// Run transfer cleanup before taking a binding lock: cleanup locks the
// registration first, as does connection redemption. Also used for cached
// retries so they cannot bypass current keeper/account authorization.
export async function authorizeSignature(
  db: Database,
  deps: MuseDeps,
  a: Actor,
  tokenId: number,
  signer: string,
) {
  requireValue(
    !a.agent,
    403,
    "SCOPE_DENIED",
    "Only the account owner can do this.",
  );
  const view = await keeperMuse(db, deps, a, tokenId);
  requireValue(
    view.controllers.includes(signer.toLowerCase()),
    403,
    "NOT_MUSE_KEEPER",
    "This linked wallet does not control the muse.",
  );
  requireValue(
    view.binding,
    403,
    "MUSE_NOT_BOUND",
    "Start this muse with your account before signing.",
  );
  return view;
}

async function rebuildLine(
  db: Database,
  deps: MuseDeps,
  binding: MuseBindingRow,
  kind: SignatureKind,
  place: PlaceId | null,
  at: number | null,
): Promise<{ line: string; url: string | null } | null> {
  const tokenId = binding.token_id;
  if (kind === "elsewhere") {
    if (place !== null || at === null) return null;
    const url = `${deps.origin}/muses/${tokenId}`;
    return { line: elsewhereLine(tokenId, url, at), url };
  }
  if (!place) return null;
  const report = await db.one<MuseReportRow>(
    "SELECT * FROM musecity.muse_reports WHERE binding_id=$1 AND step=$2",
    [binding.id, place],
  );
  if (!report) return null;
  if (kind === "flock_claim")
    return place === "flock" && at === null && report.founding_number !== null
      ? { line: flockClaimLine(tokenId, report.founding_number), url: null }
      : null;
  if (
    place === "flock" ||
    place === "hiveverse" ||
    at === null ||
    !report.url ||
    !placePageValid(place, report.url)
  )
    return null;
  if (kind === "muse_link")
    return place === "terrakin"
      ? { line: museLinkLine(tokenId, report.url, at), url: report.url }
      : null;
  return { line: livesAtLine(tokenId, place, report.url, at), url: report.url };
}

export async function submitSignature(
  db: Database,
  deps: MuseDeps,
  a: Actor,
  tokenId: number,
  body: MuseSignature,
): Promise<{ id: string; state: "queued" | "handed_to_agent" }> {
  const view = await authorizeSignature(db, deps, a, tokenId, body.signer);
  const binding = await db.one<MuseBindingRow>(
    "SELECT * FROM musecity.muse_bindings WHERE token_id=$1 AND account_id=$2 AND ended_at IS NULL FOR UPDATE",
    [tokenId, a.account.id],
  );
  requireValue(
    binding,
    403,
    "MUSE_NOT_BOUND",
    "This muse no longer belongs to this account.",
  );
  const place = body.place ?? null;
  const at = body.at ?? null;
  if (body.kind !== "flock_claim")
    requireValue(
      withinWindow(at),
      400,
      "SIGNATURE_EXPIRED",
      "This line has expired. Please sign again.",
    );
  const offered = view.needsYou.sign.some(
    (line) => line.kind === body.kind && line.place === place,
  );
  const existing = await db.one(
    "SELECT id FROM musecity.muse_signatures WHERE binding_id=$1 AND kind=$2 AND place IS NOT DISTINCT FROM $3 AND state IN ('queued','sent','handed_to_agent')",
    [binding.id, body.kind, place],
  );
  const rebuilt = await rebuildLine(db, deps, binding, body.kind, place, at);
  requireValue(
    offered && !existing && rebuilt,
    400,
    "LINE_NOT_PENDING",
    "This line is not waiting for a signature.",
  );
  let localSigner: string | undefined;
  try {
    localSigner = await recoverMessageAddress({
      message: rebuilt.line,
      signature: body.signature as `0x${string}`,
    });
  } catch {
    /* Contract proofs fall through to ERC-1271. */
  }
  requireValue(
    localSigner?.toLowerCase() === body.signer.toLowerCase() ||
      (await deps.chain.verifyMessage(
        body.signer,
        rebuilt.line,
        body.signature as `0x${string}`,
      )),
    403,
    "SIGNATURE_INVALID",
    "The signature does not match this line.",
  );
  const signatureId = id("msg"),
    state = body.kind === "flock_claim" ? "handed_to_agent" : "queued";
  await db.query(
    "INSERT INTO musecity.muse_signatures(id,binding_id,kind,place,line,at,signer,signature,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [
      signatureId,
      binding.id,
      body.kind,
      place,
      rebuilt.line,
      at,
      body.signer.toLowerCase(),
      body.signature,
      state,
    ],
  );
  return { id: signatureId, state };
}

export async function relayPending(
  connectionString: string,
  deps: MuseDeps,
): Promise<{ sent: number; left: number }> {
  return withDatabase(connectionString, (db) =>
    withDatabase(connectionString, async (budget) => {
      const candidates = await db.query<{ id: string; binding_id: string }>(
        "SELECT id,binding_id FROM musecity.muse_signatures WHERE state='queued' ORDER BY created_at,id",
      );
      let sent = 0;
      for (const candidate of candidates) {
        const outcome = await db.transaction(async () => {
          // Serialize attempts before computing the minute's budget slot. Each
          // result commits separately so a later failure cannot undo earlier
          // HTTP results. No session lock escapes into the connection pool.
          await db.query("SELECT pg_advisory_xact_lock(8004,0)");
          // Reports lock binding → signatures too. Re-read after both lock waits;
          // the candidate snapshot cannot authorize an HTTP request.
          const hint = await db.one<MuseBindingRow>(
            "SELECT * FROM musecity.muse_bindings WHERE id=$1",
            [candidate.binding_id],
          );
          if (hint && !hint.ended_at) {
            const record = (await deps.musegod.muse(hint.token_id)).value;
            if (await endIfTransferred(db, deps, hint, record.agent.wallet))
              return "skip";
          }
          const binding = await db.one<MuseBindingRow>(
            "SELECT * FROM musecity.muse_bindings WHERE id=$1 FOR UPDATE",
            [candidate.binding_id],
          );
          if (!binding) return "skip";
          const row = await db.one<MuseSignatureRow>(
            "SELECT * FROM musecity.muse_signatures WHERE id=$1 AND state='queued' FOR UPDATE",
            [candidate.id],
          );
          if (!row) return "skip";
          const expire = async () => {
            if (withinWindow(row.at)) return false;
            await db.query(
              "UPDATE musecity.muse_signatures SET state='expired' WHERE id=$1",
              [row.id],
            );
            return true;
          };
          // Flock proofs are never external relay requests, even if a stale or
          // malformed queued row exists. Only submitSignature hands them over.
          if (row.kind === "flock_claim") {
            await db.query(
              "UPDATE musecity.muse_signatures SET state='failed',result_code='invalid_relay_kind' WHERE id=$1",
              [row.id],
            );
            return "skip";
          }
          if (await expire()) return "skip";
          if (binding.ended_at) return "skip";
          const rebuilt = await rebuildLine(
            db,
            deps,
            binding,
            row.kind,
            row.place,
            row.at,
          );
          if (!rebuilt || rebuilt.line !== row.line) {
            await db.query(
              "UPDATE musecity.muse_signatures SET state='superseded' WHERE id=$1",
              [row.id],
            );
            return "skip";
          }
          try {
            // Persist the charge before HTTP, independently of the row's
            // transaction. Even a lost connection or failed result UPDATE must
            // not refund an attempt already made. This connection takes no
            // account, registration, binding or global relay locks.
            await rateLimit(budget, "musegod-relay", 8);
          } catch (error) {
            if (error instanceof ApiError && error.status === 429)
              return "stop";
            throw error;
          }
          // A budget row can block behind another transaction across the expiry
          // boundary. Never send based on the clock observed before that wait.
          if (await expire()) return "skip";
          const proof = {
            at: row.at,
            signer: row.signer,
            signature: row.signature,
          };
          const result =
            row.kind === "muse_link"
              ? await deps.musegod.postMuseLink({
                  id: binding.token_id,
                  endpoint: rebuilt.url,
                  ...proof,
                })
              : await deps.musegod.postWorlds(binding.token_id, {
                  place: row.kind === "elsewhere" ? "elsewhere" : row.place,
                  url: rebuilt.url,
                  ...proof,
                });
          if (result.status === 200) {
            await db.query(
              "UPDATE musecity.muse_signatures SET state='sent',sent_at=now(),result_code=NULL WHERE id=$1",
              [row.id],
            );
            return "sent";
          } else if (result.status === 429 || result.status === 503)
            await db.query(
              "UPDATE musecity.muse_signatures SET attempts=attempts+1,result_code=$2 WHERE id=$1",
              [row.id, result.code],
            );
          else
            await db.query(
              "UPDATE musecity.muse_signatures SET state='failed',result_code=$2 WHERE id=$1",
              [row.id, result.code],
            );
          return result.status === 429 ? "stop" : "skip";
        });
        if (outcome === "sent") sent++;
        if (outcome === "stop") break;
      }
      const count = await db.one<{ left: string }>(
        "SELECT count(*) AS left FROM musecity.muse_signatures WHERE state='queued'",
      );
      return { sent, left: Number(count?.left ?? 0) };
    }),
  );
}
