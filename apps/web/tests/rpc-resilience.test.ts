import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeAbiParameters } from "viem";
import { governanceRules } from "../src/shared/governance";

const configured = "https://configured.example.test/rpc";
const endpoints = [
  configured,
  "https://rpc.mainnet.chain.robinhood.com",
  "https://robinhood.drpc.org",
  "https://robinhood-rpc.publicnode.com",
];
const owner = "0xaabbccddeeff00112233445566778899aabbccdd";
const marker = "PROVIDER_CONTROLLED_TEXT";
let chain: typeof import("../src/server/muse-chain");
let wallets: typeof import("../src/server/wallets");
type Call = { endpoint: string; methods: string[] };
type Failure = { status: number } | { code: number; message: string };
function stub(
  handler: (endpoint: string, methods: string[]) => Failure | undefined,
) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const endpoint = String(input).replace(/\/$/, "");
      const body = JSON.parse(String(init?.body));
      const requests = Array.isArray(body) ? body : [body];
      const methods = requests.map((r: { method: string }) => r.method);
      calls.push({ endpoint, methods });
      const failure = handler(endpoint, methods);
      if (failure && "status" in failure)
        return new Response(null, { status: failure.status });
      const replies = requests.map((r: { id: number; method: string }) => ({
        jsonrpc: "2.0",
        id: r.id,
        ...(failure
          ? { error: failure }
          : {
              result:
                r.method === "eth_chainId"
                  ? "0x1237"
                  : Array.isArray(body)
                    ? encodeAbiParameters([{ type: "address" }], [owner])
                    : "0x1",
            }),
      }));
      return Response.json(Array.isArray(body) ? replies : replies[0]);
    }),
  );
  return calls;
}
const read = (kind: "muse" | "balance") =>
  kind === "muse"
    ? chain
        .robinhoodMuseChain(configured)
        .verifyMessage(owner, "Muse ownership", "0x1234")
    : wallets
        .privyWalletServices("local-app", "local-secret", configured)
        .balance(owner, governanceRules);
beforeEach(async () => {
  vi.resetModules();
  chain = await import("../src/server/muse-chain");
  wallets = await import("../src/server/wallets");
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-29T00:00:00Z"));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

for (const kind of ["muse", "balance"] as const)
  describe(kind + " RPC resilience", () => {
    it("uses configured first while healthy without touching a public endpoint", async () => {
      const calls = stub(() => undefined);
      await read(kind);
      await read(kind);
      expect(calls.every((r) => r.endpoint === configured)).toBe(true);
      expect(
        calls.filter((r) => r.methods.includes("eth_chainId")),
      ).toHaveLength(1);
      expect(console.warn).not.toHaveBeenCalled();
      expect(console.error).not.toHaveBeenCalled();
    });

    it("recovers from the production sequence: configured 429, public-1 chain succeeds then JSON-RPC limit", async () => {
      const calls = stub((endpoint, methods) =>
        endpoint === configured
          ? { status: 429 }
          : endpoint === endpoints[1] && methods.includes("eth_call")
            ? { code: -32005, message: marker }
            : undefined,
      );
      await read(kind);
      expect([...new Set(calls.map((r) => r.endpoint))]).toEqual(
        endpoints.slice(0, 3),
      );
      const before = calls.length;
      await read(kind === "muse" ? "balance" : "muse");
      expect(calls.slice(before).map((r) => r.endpoint)).toEqual([
        endpoints[2],
      ]);
      expect(
        vi.mocked(console.warn).mock.calls.map(([line]) => JSON.parse(line)),
      ).toMatchObject([
        { event: "rpc.fallback", endpoint: "configured", status: 429 },
        { event: "rpc.fallback", endpoint: "public-1", code: -32005 },
      ]);
      expect(console.error).not.toHaveBeenCalled();
      vi.setSystemTime(Date.now() + 600_000);
      await read(kind);
      expect(calls.filter((r) => r.endpoint === configured)).toHaveLength(2);
      expect(vi.mocked(console.warn).mock.calls).toHaveLength(4);
    });

    it("tries all four endpoints in order on HTTP 403/408 and a JSON-RPC internal error", async () => {
      const calls = stub((endpoint) =>
        endpoint === configured
          ? { status: 403 }
          : endpoint === endpoints[1]
            ? { status: 408 }
            : endpoint === endpoints[2]
              ? { code: -32603, message: marker }
              : undefined,
      );
      await read(kind);
      expect([...new Set(calls.map((r) => r.endpoint))]).toEqual(endpoints);
      expect(console.error).not.toHaveBeenCalled();
    });

    it.each([-32000, 3])(
      "does not fall back on execution revert %s or cool down the endpoint",
      async (code) => {
        const calls = stub((_endpoint, methods) =>
          methods.includes("eth_call")
            ? { code, message: "execution reverted: owner capacity limit" }
            : undefined,
        );
        for (let i = 0; i < 2; i++) {
          if (kind === "muse") await expect(read(kind)).resolves.toBe(false);
          else
            await expect(read(kind)).rejects.toMatchObject({
              code: "RPC_UNAVAILABLE",
            });
        }
        expect(calls.every((r) => r.endpoint === configured)).toBe(true);
        expect(console.warn).not.toHaveBeenCalled();
        const lines = vi
          .mocked(console.error)
          .mock.calls.map(([line]) => JSON.parse(line));
        expect(lines).toHaveLength(kind === "muse" ? 0 : 2);
        if (kind === "balance")
          expect(lines[0]).toMatchObject({
            event: "rpc.failed",
            attempts: [
              { endpoint: "configured", code, name: expect.any(String) },
            ],
          });
      },
    );

    it("retries every endpoint when all are cooling down and emits one safe failure line per read", async () => {
      const calls = stub((endpoint) =>
        endpoint === configured
          ? { status: 429 }
          : endpoint === endpoints[1]
            ? { status: 403 }
            : endpoint === endpoints[2]
              ? { code: -32005, message: marker }
              : { code: -32000, message: "network busy " + marker },
      );
      for (let i = 0; i < 2; i++) {
        const before = calls.length;
        const error = await read(kind).catch((e) => e);
        expect(error).toMatchObject({ status: 503, code: "RPC_UNAVAILABLE" });
        expect(calls.slice(before).map((r) => r.endpoint)).toEqual(endpoints);
        expect(String(error) + JSON.stringify(error)).not.toContain(marker);
      }
      expect(console.warn).toHaveBeenCalledTimes(4);
      const lines = vi
        .mocked(console.error)
        .mock.calls.map(([line]) => JSON.parse(line));
      expect(lines).toHaveLength(2);
      for (const line of lines) {
        expect(Object.keys(line)).toEqual(["event", "attempts"]);
        expect(line).toMatchObject({
          event: "rpc.failed",
          attempts: [
            { endpoint: "configured", status: 429, name: expect.any(String) },
            { endpoint: "public-1", status: 403, name: expect.any(String) },
            { endpoint: "public-2", code: -32005, name: expect.any(String) },
            { endpoint: "public-3", code: -32000, name: expect.any(String) },
          ],
        });
        for (const attempt of line.attempts)
          expect(
            Object.keys(attempt).every((key) =>
              ["endpoint", "status", "code", "name"].includes(key),
            ),
          ).toBe(true);
      }
      const logs = JSON.stringify([
        vi.mocked(console.warn).mock.calls,
        vi.mocked(console.error).mock.calls,
      ]);
      expect(logs).not.toContain(marker);
      for (const endpoint of endpoints) expect(logs).not.toContain(endpoint);
    });
  });
