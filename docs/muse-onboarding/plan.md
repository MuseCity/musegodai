# MUSEGOD Muse Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add public `/muses` and `/muses/:id` pages to musegod.ai, where anyone can follow each MUSEGOD muse's onboarding, and the keeper starts it with one line for their AI and only signs and approves.

**Architecture:** Pure step logic in `src/shared` drives both the server and the pages. Two injected services wrap the outside world: `MusegodServices` (musegod.org and flock reads/writes, with the Cache API) and `MuseChain` (Robinhood RPC: `ownerOf`, `isController`, `bindingOf`, `verifyMessage`). They are passed in through `Services`, like `wallets`, so tests use fakes. Muse Agents reuse the existing OTP connection flow; a `muse_bindings` row ties a connection to a token. Signed lines go through a server relay queue with its own rate budget.

**Tech Stack:** React Router 8 SSR, Hono, Zod 4, viem 2, Privy (`@privy-io/react-auth` 3, `@privy-io/node`), PostgreSQL (raw SQL through `Database`), Vitest 3, Cloudflare Workers.

**Spec:** `docs/muse-onboarding/design.md` (mockup: `docs/muse-onboarding/mockup.html`). Read it before any task; section numbers below refer to it.

## Global Constraints

- Repository: musegod.ai; the app is `apps/web` (written `W/` below). Work happens in the worktree `/Volumes/code/opc/musecity-muses` on branch `muse-onboarding` (Task 0 is done). The main checkout has someone else's uncommitted `PLAN.md` and `assets/musegodai-social/`; never touch them.
- Follow `AGENTS.md`: English UI and docs; Node 24, `corepack pnpm` 10.33.2; local PostgreSQL only at `127.0.0.1:65433`; **commits must not include `Co-authored-by` or other co-author metadata**; no push or deploy.
- Chain: Robinhood Chain `4663`. Muses `0x13Ea3072b7215d4C9c2Ec4f498A08c5825129836`. Adapter8004 `0x000000009d62675362a58911e3f32FEcf46F5E18`, `isController(uint256,address) view returns (bool)`, `bindingOf(uint256) view returns (uint8,address,uint256)`. Checked live: `bindingOf(6592)` = (0, Muses, 1).
- Token ids are integers 1–999. Canonical page URL is `/muses/<id>`.
- Outbound hosts: only `musegod.org` and `flock.musegod.org`, HTTPS, 5-second timeout. Cache TTLs: muse 5 min, `/muse/:id.json` 15 min, list 6 h, `/api/v1/worlds` 15 min, pot 5 min.
- Relay budget: at most **8** lines a minute through `rateLimit(db, "musegod-relay", 8)`. A signed line is valid for **600** seconds after its `at`.
- Agent report `code` enum: `verification_code`, `opensea_link`, `approval`. No free-text field from Agents is ever shown to people or signed.
- Every line a keeper signs is built by the server from a template in `W/src/shared/muses.ts`, never from Agent text.
- Never ask for, store or log a private key, seed phrase, password or flock join code.
- Visible copy is exactly as in spec §6 where the spec quotes it.

## Review Focus

1. **Odd lookups:** `/muses/%231`, `/muses/ Bard `, `/muses/BARD`, `/muses/01`, `/muses/1.0`, `/muses/1000`, and names with a colon such as "Bastion: Siege of the Bears". People expect the right muse or a clean 404, never a 500. Test: Task 2 `parseMuseRef` cases and Task 6 route cases.
2. **The NFT sits in a second, external linked wallet** (not the embedded one), or in a cold wallet with a linked delegate. The keeper expects to be recognized. Test: Task 6 `keeper via external linked wallet` and `keeper via delegate`.
3. **Double start:** the keeper clicks start twice, or starts again while an earlier code is pending. They expect one active binding and a working newest code. Test: Task 6 `second start replaces the pending code`.
4. **Partial musegod.org data:** a muse record without `worlds`, with `soul: null`, or a 5xx with no cache. The page should still render from the catalog, with places marked unavailable. Test: Task 4 `parses partial records` and Task 6 `renders from catalog when the muse record is unavailable`.
5. **The Agent changes a place URL after the keeper signed the old one.** The keeper expects the new URL to be asked for, and the old line never sent. Test: Task 8 `new report supersedes queued line`.

---

### Task 0: Worktree and baseline

**Files:** none changed.

- [ ] **Step 1: Create the worktree**

```bash
cd /Volumes/code/opc/musecity
git worktree add ../musecity-muses -b muse-onboarding master
mkdir -p ../musecity-muses/apps/web/.local
cp apps/web/.local/database.json ../musecity-muses/apps/web/.local/
cd ../musecity-muses && corepack pnpm install
```

- [ ] **Step 2: Baseline**

Run (in `apps/web`): `corepack pnpm db:migrate && corepack pnpm test`
Expected: migrations verified for all three databases; every existing test passes. Record the count; a failure here is pre-existing and must be reported, not fixed in this plan.

---

### Task 1: Scope amendment and spec entry

**Files:**
- Modify: `SPEC.md:55`, `SPEC.md:57`, `AGENTS.md:10`
- Modify: `SPEC.md` (new dated section at the top, page table near `:283`, acceptance list near `:347`)

- [ ] **Step 1: Amend the three scope lines**
  - `SPEC.md:55`: keep "independent of blockchain ecosystem affiliations" for profiles and discovery, and add: "The MUSEGOD muse pages read muse holdings and agent control on Robinhood Chain and show a muse badge on bound Agents; nothing else depends on a wallet or asset."
  - `SPEC.md:57` and `AGENTS.md:10`: replace "NFTs" with "NFT trading, minting or custody (reading MUSEGOD muse holdings and collecting a keeper's off-chain signatures for the muse pages is in scope)".

- [ ] **Step 2: Add `## MUSEGOD muse onboarding (2026-10-29)`** at the top of SPEC.md, following the dated-section style there. Condense spec §1, §5, §6 and §11 (routes, the 10 steps and their sources, keeper rule, signing, relay, Agent endpoints). Add `/muses`, `/muses/:id` and `/muses/:id/start.md` to the pages table.

- [ ] **Step 3: Verify**

Run: `grep -n "NFT" SPEC.md AGENTS.md`
Expected: no line still puts all NFTs out of scope; the new section exists.

- [ ] **Step 4: Commit**

```bash
git add SPEC.md AGENTS.md
git commit -m "Scope MUSEGOD muse onboarding into the spec"
```

---

### Task 2: Shared muse vocabulary, line templates and step derivation

**Files:**
- Create: `W/src/shared/muses.ts`, `W/src/shared/muse-steps.ts`
- Test: `W/tests/muses-shared.test.ts`

**Interfaces — Produces** (`muses.ts`):
- Constants `museContract`, `adapter8004` (lowercase), `museCount = 999`.
- `placeIds = ["flock","musebook","terrakin","opensea","x","hiveverse"] as const`, `type PlaceId`; `type ReportablePlace = Exclude<PlaceId,"hiveverse">`.
- `stepIds = ["soul","look","movein","hello", ...placeIds] as const`, `type StepId`.
- `reportCodes`, `type ReportCode`; `type SignatureKind = "lives_at" | "elsewhere" | "muse_link" | "flock_claim"`.
- `museSlug(name: string): string` — the part before the first `:`, NFKD, diacritics removed, lowercase, runs of non `[a-z0-9]` → `-`, trimmed of `-`.
- `parseMuseRef(ref: string): { id: number } | { slug: string } | null` — decodes once, trims; `^#?\d+$` with value 1–999 and no leading zero → id; otherwise `museSlug` of it if non-empty → slug; else null.
- `placePageValid(place: "musebook"|"terrakin"|"opensea"|"x", url: string): boolean` — terrakin `^https://terrakin\.org/r/r_[0-9a-f]{16}$`; musebook `^https://musebook\.me/[^\s?#]+$`; opensea `^https://opensea\.io/[A-Za-z0-9_.-]{1,64}$`; x `^https://x\.com/[A-Za-z0-9_]{1,15}$`.
- `livesAtLine(id, place, url, at)`, `elsewhereLine(id, url, at)`, `museLinkLine(id, url, at)` (two lines joined by `\n`, no trailing newline), `flockClaimLine(id, founding)` — exact text from spec §5.
- Zod: `museReportSchema` (spec §7 body; `founding_number` positive int; `wallet_address` 0x40-hex; `status: "skipped"` is accepted only with `step: "look"`, for a keeper whose Meta Muse already carries another muse), `museSignatureSchema` `{ kind, place?, at?, signer, signature }`.
- View types:
  - `StepStatus = "done" | "half" | "pending" | "skipped"`; `StepSource = "reported" | "musegod.ai" | "musegod.org"`
  - `MuseStep = { id: StepId; status: StepStatus; source: StepSource; evidence: string | null; lastKeeper: boolean; via: "worn" | "own" | null }`
  - `MuseWorlds = Partial<Record<PlaceId, { linked: boolean; current: boolean; url: string | null; via?: "worn" | "own" }>> & { elsewhere?: string[] }`
  - `MuseSummary = { id: number; name: string; tier: string; patron: string; line: string | null; intro: string | null; tone: string[]; kin: { id: number; name: string; tier: string }[]; images: { thumb: string; large: string }; page: string; opensea: string }`
  - `MuseView = { muse: MuseSummary; keeper: string; agent: { id: string; name: string } | null; startedAt: string | null; steps: MuseStep[]; progress: { done: number; total: 10 }; asOf: string | null; placesAvailable: boolean }`
  - `DirectoryItem = { id: number; name: string; thumb: string; done: number; awake: boolean; started: boolean }`; `MuseDirectory = { items: DirectoryItem[]; counts: { awake: number; living: number; complete: number } }`
  - `PendingLine = { kind: SignatureKind; place: PlaceId | null; line: string; at: number | null }`
  - `NeedsYou = { sign: PendingLine[]; openseaLink: string | null; verificationCode: boolean; pot: { closes: number } | null; sending: number; expired: number }`
  - `KeeperView = { id: number; controllers: string[]; agentLimitReached: boolean; binding: { startedAt: string; connection: AgentConnectionStatus | null } | null; reports: { step: StepId; status: "done" | "needs_you" | "skipped"; at: string }[]; needsYou: NeedsYou }`
  - `StartResult = { connectionId: string; otp: string; expiresAt: string; line: string }`
  - `AgentMuseView` is defined in Task 7.

**Produces** (`muse-steps.ts`):
- `deriveSteps(f: StepFacts): MuseStep[]` with `StepFacts = { reports: Partial<Record<"soul"|"look","done"|"skipped">>; connected: boolean; helloPostId: string|null; worlds: MuseWorlds|null }`. Rules are spec §7 "Status derivation"; `worlds: null` → places `pending` with `evidence: null`.
- `progress(steps): { done: number; total: 10 }`.
- `needsYou(f: NeedsFacts): NeedsYou` — `NeedsFacts = { id; origin; worlds: MuseWorlds|null; terrakinBadge: string|null; reports: Partial<Record<ReportablePlace,{ url: string|null; founding: number|null; code: ReportCode|null; wallet: string|null }>>; signatures: { kind: SignatureKind; place: PlaceId|null; state: string }[]; potEntered: boolean; potCloses: number|null; now: number }`. A line is pending when its fact exists, musegod.org does not yet confirm it, and no `queued`, `sent` or `handed_to_agent` signature exists for it. `at` is `now`, except `null` for `flock_claim`.

- [ ] **Step 1: Write the failing tests** in `tests/muses-shared.test.ts`:

```ts
it("slugs and refs", () => {
  expect(museSlug("Bastion: Siege of the Bears")).toBe("bastion");
  expect(parseMuseRef("1")).toEqual({ id: 1 });
  expect(parseMuseRef("#1")).toEqual({ id: 1 });
  expect(parseMuseRef("%231")).toEqual({ id: 1 });
  expect(parseMuseRef(" BARD ")).toEqual({ slug: "bard" });
  for (const bad of ["0", "1000", "01", "1.0"]) expect(parseMuseRef(bad)).not.toHaveProperty("id");
  expect(parseMuseRef("")).toBeNull();
  expect(parseMuseRef("%%")).toBeNull(); // malformed escape, never a throw
});
it("builds musegod.org and flock lines byte for byte", () => {
  expect(livesAtLine(947, "terrakin", "https://terrakin.org/r/r_0123456789abcdef", 1791000000)).toBe("muse #947 of MUSEGOD lives at https://terrakin.org/r/r_0123456789abcdef (terrakin). Signed at 1791000000.");
  expect(elsewhereLine(1, "https://musegod.ai/muses/1", 5)).toBe("muse #1 of MUSEGOD also lives at https://musegod.ai/muses/1. Signed at 5.");
  expect(museLinkLine(947, "https://terrakin.org/r/r_0123456789abcdef", 1791000000)).toBe("musegod.org: link muse #947 to https://terrakin.org/r/r_0123456789abcdef\nat 1791000000");
  expect(flockClaimLine(417, 12)).toBe("Link Muse #417 to founding #12 in the founding musegod flock at https://flock.musegod.org");
});
it("validates place pages", () => {
  expect(placePageValid("terrakin", "https://terrakin.org/r/r_0123456789abcdef")).toBe(true);
  expect(placePageValid("x", "https://x.com/feather_muse323")).toBe(true);
  expect(placePageValid("x", "https://twitter.com/a")).toBe(false);
  expect(placePageValid("opensea", "https://opensea.io/feathermuse?x=1")).toBe(false);
});
it("derives the ten steps with honest sources", () => { /* worlds: flock linked+current, musebook !linked, x current:false, opensea via worn */
  // expect flock done/musegod.org, musebook half, x pending with lastKeeper true, opensea done via "worn", soul done/reported, progress().done === count of done
});
it("asks the keeper only for what is missing", () => {
  // reports: flock founding 12, terrakin url; worlds: none linked; terrakinBadge null; no signatures
  // expect sign kinds ["flock_claim","lives_at"(terrakin),"elsewhere","muse_link"], flock_claim.at === null
  // with a queued lives_at for terrakin → that line is absent and sending === 1
});
```

Turn the two commented tests into concrete fixtures and `expect`s exactly as their comments describe. Also add:

```ts
it("gives all 999 muses distinct slugs", () => {
  const names: { id: number; name: string }[] = JSON.parse(readFileSync("tests/fixtures/muse-names.json", "utf8"));
  expect(names).toHaveLength(999);
  expect(new Set(names.map((m) => museSlug(m.name))).size).toBe(999);
});
it("accepts skipped only for the look step", () => {
  expect(museReportSchema.safeParse({ step: "look", status: "skipped" }).success).toBe(true);
  expect(museReportSchema.safeParse({ step: "soul", status: "skipped" }).success).toBe(false);
});
```

Create the fixture once from musegod.org's public list (public data, committed):

```bash
node -e 'const all=[];(async()=>{for(let o=0;o<1000;o+=100){const r=await (await fetch("https://musegod.org/api/v1/muses?limit=100&offset="+o)).json();all.push(...r.muses.map(m=>({id:m.id,name:m.name})));if(r.muses.length<100)break}require("fs").writeFileSync("tests/fixtures/muse-names.json",JSON.stringify(all.sort((a,b)=>a.id-b.id)))})()'
```

- [ ] **Step 2: Run** `corepack pnpm vitest run tests/muses-shared.test.ts` — Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** `muses.ts` and `muse-steps.ts` with the signatures above. Pure functions only; no imports from `src/server`.
- [ ] **Step 4: Run** the same command — Expected: PASS.
- [ ] **Step 5: Commit** `git add W/src/shared/muses.ts W/src/shared/muse-steps.ts W/tests/muses-shared.test.ts W/tests/fixtures/muse-names.json && git commit -m "Add shared muse steps, slugs and signed-line templates"`

---

### Task 3: Migration and schema

**Files:**
- Create: `W/migrations/0014_muses.sql`
- Modify: `W/src/server/schema.ts` (add the three tables in the existing `appSchema.table` style, export row types `MuseBindingRow`, `MuseReportRow`, `MuseSignatureRow`)
- Test: `W/tests/muses-migration.test.ts`

Tables are exactly spec §7, plus:
- `muse_bindings`: `id text PK`, `token_id integer CHECK (token_id BETWEEN 1 AND 999)`, `agent_id_8004 integer NOT NULL`, `account_id text REFERENCES musecity.accounts(id) ON DELETE CASCADE`, `registration_id text REFERENCES musecity.registrations(id)`, `agent_id text REFERENCES musecity.agents(id)`, `holder_address text NOT NULL`, `description text NOT NULL`, `started_at`, `ended_at`, `end_reason CHECK IN ('transferred','disconnected','restarted')`; `CREATE UNIQUE INDEX muse_bindings_active ON musecity.muse_bindings(token_id) WHERE ended_at IS NULL`; index on `agent_id`.
- `muse_reports`: PK `(binding_id, step)`; `step CHECK IN` the ten step ids except `movein`, `hello`, `hiveverse`; `status CHECK IN ('done','needs_you','skipped')`; `code CHECK IN` the enum or NULL.
- `muse_signatures`: `id text PK`, `state CHECK IN ('queued','sent','handed_to_agent','failed','expired','superseded')`, `attempts integer NOT NULL DEFAULT 0`, `created_at`.
- `REVOKE ALL … FROM PUBLIC; GRANT SELECT,INSERT,UPDATE ON … TO musecity_runtime;` for each, like `0004_move_in.sql`.

- [ ] **Step 1: Write the failing test** `muses-migration.test.ts`: as admin (`config.testAdminUrl`), insert two active bindings for token 1 → expect the second insert to reject with a unique violation; insert `token_id = 1000` → check violation; `state = 'pending'` → check violation.
- [ ] **Step 2: Run** `corepack pnpm vitest run tests/muses-migration.test.ts` — Expected: FAIL (relation does not exist).
- [ ] **Step 3: Write the migration and schema entries; run** `corepack pnpm db:migrate`.
- [ ] **Step 4: Run** the test, then `corepack pnpm vitest run tests/migration-boundaries.test.ts` — Expected: both PASS.
- [ ] **Step 5: Commit** `git commit -m "Store muse bindings, Agent reports and signed lines"` (migration, schema, test).

---

### Task 4: musegod.org and flock client

**Files:**
- Create: `W/src/server/musegod.ts`
- Test: `W/tests/musegod-client.test.ts`

**Interfaces — Produces:**

```ts
export type Fetched<T> = { value: T; asOf: string; stale: boolean };
export type ResponseCache = { match(r: Request): Promise<Response | undefined>; put(r: Request, res: Response): Promise<void> };
export type MuseRecord = { id: number; name: string; tier: string; patron: string; soul: { intro: string; tone: string[]; line: string } | null; kin: { id: number; name: string; tier: string }[]; owner: string; agent: { agentId: number; wallet: string | null }; worlds: MuseWorlds; images: { thumb: string; large: string } };
export type CatalogEntry = { id: number; name: string; owner: string; thumb: string };
export type MusegodServices = {
  muse(id: number): Promise<Fetched<MuseRecord>>;
  catalog(): Promise<Fetched<CatalogEntry[]>>;            // all 999, paged internally (limit 100)
  gallery(): Promise<Fetched<{ living: number; muses: { id: number; linked: PlaceId[] }[] }>>;
  terrakinBadge(id: number): Promise<string | null>;       // /muse/:id.json services
  pot(): Promise<{ muses: number[]; closes: number }>;
  founding(n: number): Promise<{ name: string } | null>;  // flock /api/v1/founding/{n}
  postWorlds(id: number, body: Record<string, unknown>): Promise<{ status: number; code: string | null }>;
  postMuseLink(body: Record<string, unknown>): Promise<{ status: number; code: string | null }>;
};
export function musegodOrg(opts: { fetch?: typeof fetch; cache?: ResponseCache; now?: () => number }): MusegodServices;
```

Behavior: responses parsed with Zod (unknown fields ignored; missing `worlds` → `{}`; `soul: null` allowed; addresses lowercased). A cached copy carries an `x-fetched-at` header; within its TTL it is returned as is; past TTL a refetch is tried, and on timeout or 5xx the stale copy is returned with `stale: true`; with no copy, throw `ApiError(503, "MUSEGOD_UNAVAILABLE", "Muse data is unavailable right now.")`. Hosts are checked against the allowlist before every request; redirects are `manual` and refused. POST results return `{ status, code }` from musegod.org's error body, never its message.

- [ ] **Step 1: Write the failing tests**, with a fake `fetch` and an in-memory `ResponseCache`:
  - `parses partial records`: muse JSON without `worlds` and with `soul: null` → `value.worlds` is `{}` and `soul` is null.
  - `serves stale on failure`: first call 200; advance `now` past 5 min; fake returns 503 → `stale: true`, same value.
  - `fails cleanly with no copy`: fake throws → rejects with code `MUSEGOD_UNAVAILABLE`.
  - `catalog pages to 999`: fake returns 10 pages of 100 (last has 99) → 999 entries.
  - `refuses other hosts`: a `muse` record whose `images` point elsewhere is still parsed, but `founding()` never calls any host other than `flock.musegod.org` (assert the fake saw only allowlisted hosts).
  - `relays POST results`: fake 429 with `{error:{code:"rate_limited"}}` → `{ status: 429, code: "rate_limited" }`.
- [ ] **Step 2: Run** `corepack pnpm vitest run tests/musegod-client.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `musegodOrg`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Read musegod.org and the flock through a cached client"`.

---

### Task 5: Chain reads and linked wallets

**Files:**
- Create: `W/src/server/muse-chain.ts`
- Modify: `W/src/server/wallets.ts` (add `linkedEvmAddresses` and `WalletServices.linkedAddresses`)
- Modify: `W/src/server/api.ts:93-128` (`Services` gains `musegod?: MusegodServices; museChain?: MuseChain; waitUntil?: (p: Promise<unknown>) => void`; `productionServices` wires `musegodOrg({ cache: caches.open("musecity-musegod-v1") adapter })`, `robinhoodMuseChain(env.ROBINHOOD_RPC_URL)`, `waitUntil: (p) => ctx.waitUntil(p)`)
- Test: `W/tests/muse-chain.test.ts`, extend `W/tests/wallets.test.ts`

**Interfaces — Produces:**

```ts
export type MuseChain = {
  ownerOf(tokenId: number): Promise<string>;                       // lowercase
  isController(agentId: number, address: string): Promise<boolean>;
  bindingOf(agentId: number): Promise<{ standard: number; contract: string; tokenId: number }>;
  verifyMessage(address: string, message: string, signature: `0x${string}`): Promise<boolean>; // EOA, ERC-1271, ERC-6492
};
export function robinhoodMuseChain(rpcUrl?: string): MuseChain;
export function linkedEvmAddresses(user: { id: string; linked_accounts: unknown[] }, userId: string): string[];
// WalletServices.linkedAddresses(privyUserId: string): Promise<string[]>
```

`robinhoodMuseChain` builds a viem public client per call site (no shared batch scheduler — see the comment at `wallets.ts:95`), HTTPS only, checks chain id 4663 once per instance, and keeps a 60-second in-memory cache for `ownerOf` and `isController`. `linkedEvmAddresses` returns every `type: "wallet"`, `chain_type: "ethereum"` address (embedded and external), lowercased and de-duplicated, after the same `user.id === userId` check as `qualificationWallet`.

- [ ] **Step 1: Write the failing tests**
  - `linkedEvmAddresses` keeps embedded and external Ethereum wallets, drops Solana and non-wallet accounts, lowercases, and throws `WALLET_UNAVAILABLE` on a user-id mismatch.
  - `robinhoodMuseChain` with `vi.stubGlobal("fetch", …)` answering JSON-RPC: `ownerOf(1)` decodes a padded address to lowercase; `bindingOf(6592)` decodes `(0, muses, 1)`; a non-HTTPS URL throws `RPC_UNAVAILABLE`; a wrong chain id throws `RPC_UNAVAILABLE`.
  - `verifyMessage` accepts a real signature from `privateKeyToAccount(generatePrivateKey()).signMessage` and rejects a tampered message.
- [ ] **Step 2: Run** `corepack pnpm vitest run tests/muse-chain.test.ts tests/wallets.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement**; wire `productionServices`.
- [ ] **Step 4: Run** the same — Expected: PASS. Then `corepack pnpm typecheck` — Expected: no errors.
- [ ] **Step 5: Commit** `git commit -m "Read muse ownership and agent control on Robinhood Chain"`.

---

### Task 6: Public muse pages API, keeper start and bindings

**Files:**
- Create: `W/src/server/muses.ts`
- Create: `W/tests/muse-fakes.ts` (fake `MusegodServices`, fake `MuseChain` backed by maps and real viem signature checks, fake `linkedAddresses`; `withMuses(f)` attaches them to `f.services`)
- Modify: `W/src/server/agents.ts:23` (`createConnection(db, a, name, muse?: { tokenId: number; agentId8004: number; holder: string; description: string })` inserts the binding in the same transaction), `W/src/server/agents.ts:317` (`activate` calls `bindRedeemedAgent` after the agent insert)
- Modify: `W/src/server/api.ts` (routes below; helper `museDeps()` → `requireValue(s.musegod && s.museChain && s.wallets, 503, "MUSES_UNAVAILABLE", …)`)
- Test: `W/tests/muses.test.ts`

**Interfaces — Consumes:** Task 2 types and `deriveSteps`/`progress`/`needsYou`; Task 4 `MusegodServices`; Task 5 `MuseChain`, `linkedAddresses`.

**Produces:**

```ts
export type MuseDeps = { musegod: MusegodServices; chain: MuseChain; wallets: WalletServices; origin: string };
export function bindingStillHeld(i: { ownerOf: string; holder: string; linked: string[]; agentWallet: string | null }): boolean;
export async function resolveMuse(deps: MuseDeps, ref: string): Promise<{ id: number; name: string }>; // 404 MUSE_NOT_FOUND
export async function publicMuse(db: Database, deps: MuseDeps, ref: string): Promise<MuseView>;
export async function directory(db: Database, deps: MuseDeps, params: URLSearchParams, a?: Actor): Promise<MuseDirectory>;
export async function controllersFor(deps: MuseDeps, a: Actor, tokenId: number): Promise<{ agentId8004: number; controllers: string[] }>;
export async function startMuse(db: Database, deps: MuseDeps, a: Actor, tokenId: number): Promise<StartResult>;
export async function keeperMuse(db: Database, deps: MuseDeps, a: Actor, tokenId: number): Promise<KeeperView>;
export async function myMuses(db: Database, deps: MuseDeps, a: Actor): Promise<DirectoryItem[]>;
export async function restartMuse(db: Database, deps: MuseDeps, a: Actor, tokenId: number): Promise<{ restarted: true }>;
export async function bindRedeemedAgent(db: Database, registrationId: string, agentId: string): Promise<void>;
```

Routes (all JSON, existing error contract):
- `GET /api/v1/muses?q=&filter=` → `directory` (`filter`: `all|awake|complete|not_started|mine`; `mine` needs a session, else 401).
- `GET /api/v1/muses/:ref` → `publicMuse` (public; body carries `muse.id` so the page can redirect).
- `GET /api/v1/me/muses` → `myMuses`; `GET /api/v1/me/muses/:id` → `keeperMuse`; `POST /api/v1/me/muses/:id/start` → `startMuse` (201); `POST /api/v1/me/muses/:id/restart` → `restartMuse`. All `/me/muses*` use `authed(c, undefined, true, …)`.

Rules:
- Agent id: from `musegod.muse(id).agent.agentId`, confirmed by `chain.bindingOf` = `(0, museContract, id)` before first use, then stored on the binding.
- Keeper: `controllersFor` returns the linked addresses passing `isController`. None → 403 `NOT_MUSE_KEEPER`.
- `startMuse`: ends any active binding for the token that belongs to this account (`restarted`) and cancels its pending registration; refuses with 409 `MUSE_KEPT_ELSEWHERE` if another account holds an active binding and still passes `bindingStillHeld`. Otherwise it ends that binding as `transferred`. It then calls `createConnection(db, a, name, muse)` with `description = "muse #<id> of MUSEGOD. " + soul.intro` (≤ 500 chars) and returns `line` = `Be muse #<id> (read https://musegod.org/muse/<id>.txt), then set yourself up by following <origin>/muses/<id>/start.md with code <otp>`.
- `bindRedeemedAgent`: sets `agent_id`, `public_visible = true` and `description` on the new Agent when the registration belongs to an active binding.
- Transfer check: `publicMuse` and `keeperMuse` compare musegod.org's `owner` with the binding's holder and agent wallet; on a mismatch they confirm with `chain.ownerOf` and the binding account's `linkedAddresses`, and end it as `transferred` when `bindingStillHeld` is false.
- `publicMuse` never returns the code, connection id or pending lines; the keeper's address is returned in full and shortened by the page.
- `KeeperView` carries `agentLimitReached: boolean` (the same count `createConnection` uses), so the page can say so before the keeper starts.
- `keeperMuse` builds `NeedsFacts` from the binding's reports and signatures, `musegod.muse(id).worlds`, `musegod.terrakinBadge(id)` and `musegod.pot()` (`potEntered = week.muses.includes(id)`), then calls `needsYou`.
- `myMuses` lists catalog entries whose `owner` is one of the account's linked addresses (display only; Review Focus 2's delegate case is covered once the keeper opens the muse).

- [ ] **Step 1: Write the failing tests** in `tests/muses.test.ts` (use `withMuses(fixture())`):
  - `resolves ids, hashes and names; 404s the rest` — `/muses/1`, `/muses/%231`, `/muses/bard` → `muse.id === 1`; `/muses/0`, `/muses/xyz` → 404 `MUSE_NOT_FOUND`.
  - `public view hides keeper secrets` — after alice starts, signed-out `GET /muses/1` has no `otp`, `line`, `connectionId` or `pending` anywhere in the JSON string.
  - `keeper via external linked wallet` and `keeper via delegate` — the controller is alice's second linked address (or a delegate the fake chain marks as controller) → start 201.
  - `non-keeper gets 403` — bob → `POST /me/muses/1/start` → 403 `NOT_MUSE_KEEPER`.
  - `second start replaces the pending code` — two starts → one active binding; the first code fails redemption with 401 `INVALID_CREDENTIAL`; the second succeeds.
  - `redeeming binds the Agent with the NFT's name and description` — redeem via `/agent-connections`, then `GET /agent` → name `Bard`, binding `agent_id` set, Agent `public_visible` true.
  - `steps 3 and 4 come from musegod.ai` — before `GET /agent`, step `movein` is `pending`; after it, `done`/`musegod.ai`; after the Agent posts, `hello` is `done` with the post id as evidence.
  - `sale ends the binding; a move to the muse's own wallet does not` — set fake owner to a stranger → next `GET /muses/1` shows `startedAt: null`, binding `end_reason = 'transferred'`; separately set owner to `agent.wallet` → binding stays.
  - `renders from catalog when the muse record is unavailable` — fake `muse()` throws 503, `catalog()` works → 200 with name and places `pending`, `asOf: null`.
  - `directory filters and counts` — `filter=awake` lists only muses with a connected Agent; `q=bard` returns `{ items: [Bard] }`; `filter=mine` lists alice's muses for alice, nothing for bob, and 401 signed out.
  - `warns at the Agent limit` — alice already has 20 Agents → `GET /me/muses/1` has `agentLimitReached: true`, and start → 409 `AGENT_LIMIT`.
- [ ] **Step 2: Run** `corepack pnpm vitest run tests/muses.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `muses.ts`, the `agents.ts` changes and the routes.
- [ ] **Step 4: Run** the test, then `corepack pnpm vitest run tests/agent-connection.test.ts tests/move-in.test.ts` — Expected: all PASS (the existing connection flow is unchanged without `muse`).
- [ ] **Step 5: Commit** `git commit -m "Serve public muse pages and let keepers start their muse"`.

---

### Task 7: Agent setup and reports (REST and MCP)

**Files:**
- Create: `W/src/server/muse-agent.ts`
- Modify: `W/src/server/api.ts` (routes), `W/src/server/mcp.ts:201-228` (scope map) and tool registrations near `:265`
- Modify: `W/src/server/discovery.ts` (OpenAPI paths for the two endpoints, in the existing style)
- Test: `W/tests/muse-agent.test.ts`, extend `W/tests/mcp.test.ts`

**Interfaces — Produces:**
- `agentMuse(db, deps, a): Promise<AgentMuseView>` — `{ id, name, page: "<origin>/muses/<id>", steps: MuseStep[], next: StepId | null, signatures: { kind: "flock_claim"; founding: number; address: string; signature: string }[] }`. `signatures` lists `handed_to_agent` rows only.
- `reportMuseStep(db, deps, a, body: MuseReport): Promise<{ accepted: true }>`.
- Routes: `GET /api/v1/agent/muse` (`authed(c, "content:read", false, …)`), `POST /api/v1/agent/muse/reports` (`write(c, "content:write", false, body, …)`). Both require `a.agent` with an active binding, else 403 `MUSE_NOT_BOUND`.
- MCP: `get_muse_setup` → `GET /agent/muse`; `report_muse_step` → `POST /agent/muse/reports` (write, idempotent, add to the `content:write` list).

Validation: `url` must pass `placePageValid` (→ 400 `invalid_place_url`); `founding_number` must exist and `musegod.founding(n).name` must equal the muse name, case-insensitively (→ 400 `invalid_founding_number`); `step: "hiveverse"`, `"movein"` or `"hello"` → 400 `VALIDATION_ERROR`. A report upserts by `(binding_id, step)`. A new `url` or `founding_number` for a place (different from the stored one) marks that place's `queued`, `sent` and `handed_to_agent` lines `superseded`, so the keeper is asked to sign the new value. Every accepted report calls `audit(d, a, "muse.report", bindingId)`.

- [ ] **Step 1: Write the failing tests**
  - `only bound Agents may call` — an Agent connected the ordinary way → 403 `MUSE_NOT_BOUND` on both.
  - `accepts done reports and shows them as reported` — `soul` and `look` → public steps `done`/`reported`; `look` reported `skipped` → status `skipped`, not counted in `progress`.
  - `rejects bad URLs and founding numbers` — `x` with `https://twitter.com/a` → `invalid_place_url`; founding 12 whose fake name is "Nova" → `invalid_founding_number`.
  - `needs_you codes reach the keeper only as enums` — `{ step: "opensea", status: "needs_you", code: "opensea_link", wallet_address }` → keeper view `needsYou.openseaLink` equals that address; an unknown code → 400.
  - `paused Agents are refused` — owner pauses via `PATCH /me/agents/:id` → existing paused refusal.
  - MCP (`mcp.test.ts`): both tools are listed with the right `securitySchemes` scopes; `report_muse_step` returns the REST body.
- [ ] **Step 2: Run** `corepack pnpm vitest run tests/muse-agent.test.ts tests/mcp.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same, plus `tests/discovery-contracts.test.ts` — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Let bound muse Agents read their setup and report steps"`.

---

### Task 8: Keeper signatures and the relay

**Files:**
- Create: `W/src/server/muse-relay.ts`
- Modify: `W/src/server/api.ts` (route `POST /api/v1/me/muses/:id/signatures` via `write(c, "content:write", true, body, …)`; call `relayPending` through `s.waitUntil` after a queued insert and at the start of `GET /me/muses/:id`)
- Test: `W/tests/muse-relay.test.ts`

**Interfaces — Produces:**
- `submitSignature(db, deps, a, tokenId, body: MuseSignature): Promise<{ id: string; state: "queued" | "handed_to_agent" }>`.
- `relayPending(connectionString: string, deps: MuseDeps): Promise<{ sent: number; left: number }>` — opens its own connection with `withDatabase`.

Rules:
- The line is rebuilt from the binding, the latest report and `at` (`elsewhere` uses `<origin>/muses/<id>`). Refuse with 400 `LINE_NOT_PENDING` when `needsYou` does not currently list that kind and place.
- `deps.chain.verifyMessage(signer, line, signature)` must be true (→ 403 `SIGNATURE_INVALID`) and `signer` must be in `controllersFor(...).controllers` (→ 403 `NOT_MUSE_KEEPER`). `at` must be within 600 s of now (→ 400 `SIGNATURE_EXPIRED`).
- `flock_claim` → `handed_to_agent`. The others → `queued`.
- `relayPending`: oldest `queued` first. A row older than 600 s becomes `expired`. Before each send, `rateLimit(db, "musegod-relay", 8)`; a 429 from it stops the run. Send with `postWorlds` (`{place, url, at, signer, signature}`, `place: "elsewhere"` for that kind) or `postMuseLink` (`{id, endpoint, at, signer, signature}`). 200 → `sent`; 429 or 503 → stays `queued`, `attempts + 1`; any other status → `failed` with `result_code`.

- [ ] **Step 1: Write the failing tests** (real keys from `generatePrivateKey`):
  - `signs and queues a pending line` — Agent reports terrakin URL; alice fetches `GET /me/muses/1`, signs `pending` terrakin `lives_at` with her controller key → `queued`; `relayPending` calls `postWorlds` with the exact body and the row becomes `sent`.
  - `refuses a line the server did not offer` — sign a `lives_at` for `x` with no X report → 400 `LINE_NOT_PENDING`.
  - `refuses a non-controller or tampered signature` — linked but non-controller key → 403 `NOT_MUSE_KEEPER`; signature over different text → 403 `SIGNATURE_INVALID`.
  - `expires stale lines` — `at` 601 s ago → 400 `SIGNATURE_EXPIRED`; a queued row whose `at` passes 600 s before sending → `expired`, and `needsYou.expired === 1`.
  - `respects the shared budget` — 10 queued rows → one run sends 8, leaves 2.
  - `retries 429 and 503, fails other errors` — fake `postWorlds` returns 503 then 200 → `sent` with `attempts = 1`; 403 → `failed`, `result_code = "forbidden"`.
  - `hands the flock claim to the Agent` — Agent reports founding 12; alice signs `flock_claim` → `handed_to_agent`; `GET /agent/muse` lists it with founding, address and signature; it is never posted to musegod.org.
  - `new report supersedes queued line` — queue a terrakin line, Agent reports a new terrakin URL → old row `superseded`, not sent; `needsYou.sign` asks for the new URL.
- [ ] **Step 2: Run** `corepack pnpm vitest run tests/muse-relay.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Collect keeper signatures and relay them to musegod.org"`.

---

### Task 9: The AI's skill document

**Files:**
- Create: `W/src/server/muse-skill.ts`
- Modify: `W/src/server/api.ts` (route `GET /muses/:id/start.md`, `text/markdown; charset=utf-8`, header `X-Robots-Tag: noindex`), `W/workers/app.ts:15-29` (send paths matching `/^\/muses\/[^/]+\/start\.md$/` to Hono)
- Test: `W/tests/muse-skill.test.ts`

**Produces:** `museStartDoc(origin: string, muse: MuseRecord): string` — the safety rules, then the ten numbered steps of spec §6.4, with this muse's id, name, art URL (`images.large`) and traits filled in, and these exact endpoints: `POST <origin>/api/v1/agent-connections`, `GET <origin>/api/v1/agent`, `GET <origin>/api/v1/agent/muse`, `POST <origin>/api/v1/agent/muse/reports`, and the MCP tool names. It never contains a code.

- [ ] **Step 1: Write the failing tests**
  - `is per muse and secret-free` — for Bard, the doc contains `muse #1`, `Bard`, `https://musegod.org/muse/1.txt` and `muse #1 of MUSEGOD`, and contains no `mcr_`, `mca_`, `seed phrase:`, `private key:` value or `password:` value.
  - `tells the AI to keep secrets` — it contains "credential store" and "Never send your flock join code to anyone".
  - `route` — `app.request("http://localhost/muses/1/start.md")` → 200, `X-Robots-Tag: noindex`; `/muses/0/start.md` → 404.
- [ ] **Step 2: Run** `corepack pnpm vitest run tests/muse-skill.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Publish each muse's setup skill for its AI"`.

---

### Task 10: SEO and sitemap

**Files:**
- Modify: `W/src/shared/seo.ts` (`canonicalPath`: no kept params for `/muses/<id>`, keep `filter` for `/muses`; `publicIndexable`: true for `/muses` without `q` and for `/^\/muses\/\d+$/`)
- Modify: `W/src/server/seo.ts:27-34` (static `('/muses')`; `UNION ALL SELECT '/muses/'||n, NULL::timestamptz FROM generate_series(1,999) n`)
- Test: extend `W/tests/seo.test.ts`

- [ ] **Step 1: Write the failing tests** — `/muses/1` indexable with canonical `/muses/1`; `/muses/bard` not indexable (it redirects); `/muses?q=bard` not indexable; the sitemap contains `/muses` and `/muses/999` and not `/muses/1000`; `/muses/1/start.md` is absent.
- [ ] **Step 2: Run** `corepack pnpm vitest run tests/seo.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Index the muse directory and the 999 muse pages"`.

---

### Task 11: Public pages

**Files:**
- Modify: `W/src/routes.ts` (`route("muses", "routes/muses.tsx")`, `route("muses/:ref", "routes/muse.tsx")`)
- Create: `W/src/routes/muses.tsx`, `W/src/routes/muse.tsx`, `W/src/components/muse-setup.tsx`
- Modify: `W/src/styles.css` (`.muse-*` classes built from the existing tokens at `:384-397`; no new colors)
- Create: `W/e2e/muse-fixture.ts` (fake services for the e2e server), modify `W/e2e/server.ts` to pass them
- Create: `W/e2e/verify-muses-browser.mjs`

**Interfaces — Consumes:** `MuseView`, `MuseDirectory` (Task 2); `GET /muses`, `GET /muses/:ref` (Task 6).
**Produces:** `MuseHeader({ muse, keeper, progress })`, `MuseChecklist({ steps, name })`, `MuseCard({ item })` in `muse-setup.tsx`.

Behavior:
- `muse.tsx` loader: `publicRead<MuseView>(args, "/muses/" + encodeURIComponent(params.ref))`; when `params.ref !== String(view.muse.id)`, `throw redirect("/muses/" + view.muse.id, 301)`. SEO through `pageSeo` with title `` `${name} · MUSEGOD muse #${id} — musegod.ai` ``, image = `muse.images.large`, `ProfilePage` structured data.
- Layout, copy, grouping, source labels and visitor CTA: spec §6.1 and the mockup `docs/muse-onboarding/mockup.html` (view "anyone"). "reported by Bard" rows use the muted style and the word "reported". `asOf` shows "as of <time>" when stale, and "can't check right now" when place data is missing.
- Agent posts: load with the existing `/feed` agent filter (see `publicContentParams`) and render with `CommunityCard`.
- `muses.tsx`: heading, search form (submitting an exact id or unique name navigates to `/muses/<id>`), counts, filter buttons, grid of `MuseCard`; spec §6.3.
- Neighbors entry (E3): a "Muses" link on `routes/neighbors.tsx` next to its existing view switcher.

- [ ] **Step 1: Write the browser check** `e2e/verify-muses-browser.mjs` in the style of `e2e/verify-seo-browser.mjs`: open `/muses/bard` → final URL `/muses/1`, one `<h1>` "Bard", ten checklist rows, canonical `/muses/1`; open `/muses` → search "bard" → lands on `/muses/1`; at 375 px width `document.documentElement.scrollWidth <= 375`; every button and link in the checklist and directory is reachable with Tab and has an accessible name; with `prefers-reduced-motion: reduce` emulated, no element has a running CSS animation; no page errors.
- [ ] **Step 2: Run** `corepack pnpm e2e:serve` (port 5191) in one shell and `node e2e/verify-muses-browser.mjs` in another — Expected: FAIL (routes missing).
- [ ] **Step 3: Implement the routes, components and styles.**
- [ ] **Step 4: Run** the browser check — Expected: PASS. Then `corepack pnpm typecheck && corepack pnpm format:check` — Expected: clean.
- [ ] **Step 5: Commit** `git commit -m "Add the public muse directory and muse pages"`.

---

### Task 12: Keeper start card, live progress and signing

**Files:**
- Modify: `W/src/components/auth.tsx:11-35` (`Session` gains `evmAddresses: string[]` and `signMessage(address: string, message: string): Promise<string>`; `anonymous` gets `[]` and a rejecting stub)
- Modify: `W/src/components/privy.client.tsx` (implement both from `useWallets()`: find the wallet whose address matches, case-insensitively; `await (await w.getEthereumProvider()).request({ method: "personal_sign", params: [message, w.address] })`; no match → `Error("Connect the wallet that holds this muse.")`). Check the call against the Privy v3 docs before relying on it.
- Create: `W/src/components/muse-keeper.tsx`
- Modify: `W/src/routes/muse.tsx` (render `<MuseKeeper id>` for signed-in sessions)
- Modify: `W/e2e/muse-fixture.ts`, `W/e2e/verify-muses-browser.mjs`

**Interfaces — Consumes:** `KeeperView`, `StartResult`, `NeedsYou`, `PendingLine` (Task 2); `/me/muses/:id`, `/start`, `/restart`, `/signatures` (Tasks 6 and 8).

Behavior:
- `GET /me/muses/:id` with 403 `NOT_MUSE_KEEPER` → show `Holding Bard? Link the wallet that holds it` calling `session.link("wallet")`.
- When the keeper's account has no `joinedAt`, the start card adds a non-blocking note `Finish your profile so Bard's card and posts show on its page` linking to `/move-in` (design §8).
- `agentLimitReached` → the start card shows "Your account has 20 Agents. Remove one in My agents to wake Bard." with a link to `/me/agents`, and no copy button.
- Start card: spec §6.2 steps 1–3. "Copy" runs `POST start` once and copies `StartResult.line`; the code is kept only in component state. "copy the full setup" fetches `/muses/<id>/start.md` and copies it followed by a blank line and `Your code: <otp>`; it reuses the current code, or runs start first if there is none. Polling every 5 s while visible, stopped on error, with manual refresh, exactly as `agent-connection.tsx:110-127`. Expired code → "new code".
- Needs you: the rows of spec §6.2 from `NeedsYou`. `Sign N` signs each `PendingLine` in order with `session.signMessage(controller, line.line)`, posting each to `/signatures`. The controller is the first of `session.evmAddresses` that is in `KeeperView.controllers`; with none → `Switch to the wallet that holds Bard (<short owner>)`. Show "sending…" for `sending`, and "sign again" for `expired`.
- Narrow order: start card → Needs you → checklist → posts (mockup CSS `order` rules). Wide: Needs you in a sticky right column.

- [ ] **Step 1: Extend the browser check** with the simulated keeper (Alice): start shows a line containing `/muses/1/start.md with code mcr_`; after the fixture Agent reports terrakin, Needs you shows "Confirm where Bard lives" and signing it (fixture wallet) moves the row to "sending…"; at 375 px the start card is above Needs you, and Needs you is above the checklist.
- [ ] **Step 2: Run** the browser check — Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the browser check, `corepack pnpm typecheck`, `corepack pnpm format:check` — Expected: PASS and clean.
- [ ] **Step 5: Commit** `git commit -m "Let keepers wake their muse and sign from the muse page"`.

---

### Task 13: Entry points and the muse badge

**Files:**
- Modify: `W/src/components/move-in-muse.tsx` (E1: when `GET /me/muses` is non-empty, add `You hold <name> #<id> — set it up` linking to `/muses/<id>`)
- Modify: `W/src/routes/home.tsx` (E2: "Your muses" block from `GET /me/muses`, progress bar and Continue)
- Modify: `W/src/routes/feed.tsx:112-148` (E4: in the existing `welcome-note`, `Wake up <name>` when the member keeps a muse with no binding)
- Modify: `W/src/shared/contracts.ts:442` (`Attribution = { id: string; name: string; muse: number | null } | null`), each SQL that builds an Agent attribution in `W/src/server/community.ts` (`:211`, `:341`, `:660`, `:768`, `:1013`), `W/src/server/works.ts`, `W/src/server/content.ts`, and the OpenAPI schema in `W/src/server/discovery.ts:733`. Fragment: `(SELECT mb.token_id FROM musecity.muse_bindings mb WHERE mb.agent_id=g.id AND mb.ended_at IS NULL)`
- Modify: the byline in `W/src/components/neighborhood.tsx` (badge `muse #<n>` linking to `/muses/<n>`)
- Test: extend `W/tests/muses.test.ts`, `W/tests/discovery-contracts.test.ts`

- [ ] **Step 1: Write the failing tests** — a bound Agent's post in `GET /feed` has `agent.muse === 1`; an unbound Agent's has `muse: null`; after the binding ends (`transferred`), the same post shows `muse: null`; the OpenAPI contract test accepts the new field.
- [ ] **Step 2: Run** `corepack pnpm vitest run tests/muses.test.ts tests/discovery-contracts.test.ts tests/community.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** the SQL, contract, byline and the three entry points.
- [ ] **Step 4: Run** the same tests plus the browser check from Task 11 — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "Show muse badges and point keepers to their muse"`.

---

### Task 14: Full verification and release record

**Files:**
- Modify: `PLAN.md` (new top entry `## MUSEGOD muse onboarding — implementation (<date>)`, in the style of the existing entries: scope, test counts, browser checks, evidence paths under `.local/`, rollback note that `0014_muses.sql` is additive)

- [ ] **Step 1: Run everything** in `apps/web`:

```bash
corepack pnpm db:migrate
corepack pnpm test
corepack pnpm typecheck
corepack pnpm format:check
corepack pnpm guard
corepack pnpm build
node e2e/verify-muses-browser.mjs
```

Expected: all pass; the test count is the Task 0 baseline plus the new tests.

- [ ] **Step 2: Live read-only check** — with the dev server against real musegod.org and the public Robinhood RPC (no signing, no writes): `/muses/1` shows Bard with musegod.org's place states, and `/muses/bard` redirects. Record that this is a read-only check; real wallet signing and relay to musegod.org stay unverified until a keeper does it.

- [ ] **Step 3: Write the PLAN.md entry**, separating local tests, the read-only live check, and what is still unverified (real Privy signing, real relay, real Meta Muse run).

- [ ] **Step 4: Commit** `git commit -m "Record the muse onboarding implementation"`. Do not push or deploy; that needs separate authorization.
