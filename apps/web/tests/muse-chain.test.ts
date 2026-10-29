import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashMessage, serializeErc6492Signature, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
let robinhoodMuseChain: typeof import("../src/server/muse-chain").robinhoodMuseChain;

const owner = "0xaabbccddeeff00112233445566778899aabbccdd";
const stranger = "0x2222222222222222222222222222222222222222";
type RpcRequest = {
  id: number;
  method: string;
  params: [{ to?: string; data: Hex }, string];
};
function rpcMock(handler: (request: RpcRequest) => unknown) {
  const requests: RpcRequest[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = input instanceof Request ? await input.text() : init?.body;
      const request = JSON.parse(String(body)) as RpcRequest;
      expect(Array.isArray(request)).toBe(false);
      requests.push(request);
      return Response.json({
        jsonrpc: "2.0",
        id: request.id,
        result: handler(request),
      });
    }),
  );
  return requests;
}
beforeEach(async () => {
  vi.resetModules();
  ({ robinhoodMuseChain } = await import("../src/server/muse-chain"));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("muse message verification", () => {
  it.each([3, -32000])(
    "returns false when the signature verifier reverts with RPC code %s",
    async (code) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = JSON.parse(
            String(input instanceof Request ? await input.text() : init?.body),
          );
          return Response.json({
            jsonrpc: "2.0",
            id: request.id,
            ...(request.method === "eth_chainId"
              ? { result: "0x1237" }
              : {
                  error: {
                    code,
                    message: "execution reverted: invalid signature",
                  },
                }),
          });
        }),
      );
      expect(
        await robinhoodMuseChain().verifyMessage(owner, "Bard", "0x1234"),
      ).toBe(false);
    },
  );

  it.each(["0x", "0x1", "0xzz"] as const)(
    "returns false for malformed signature %s rather than an availability error",
    async (signature) => {
      rpcMock((r) => (r.method === "eth_chainId" ? "0x1237" : "0x0"));
      expect(
        await robinhoodMuseChain().verifyMessage(owner, "Bard", signature),
      ).toBe(false);
    },
  );

  it.each(["network", "http", "rpc", "timeout"])(
    "reports %s failures during signature verification as RPC_UNAVAILABLE",
    async (failure) => {
      const { TimeoutError } = await import("viem");
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = JSON.parse(
            String(input instanceof Request ? await input.text() : init?.body),
          );
          if (request.method === "eth_chainId")
            return Response.json({
              jsonrpc: "2.0",
              id: request.id,
              result: "0x1237",
            });
          if (failure === "network") throw new TypeError("offline");
          if (failure === "timeout")
            throw new TimeoutError({
              body: {},
              url: "https://rpc.example.test",
            });
          if (failure === "http") return new Response(null, { status: 503 });
          return Response.json({
            jsonrpc: "2.0",
            id: request.id,
            error: { code: -32603, message: "unavailable" },
          });
        }),
      );
      await expect(
        robinhoodMuseChain().verifyMessage(owner, "Bard", "0x1234"),
      ).rejects.toMatchObject({ status: 503, code: "RPC_UNAVAILABLE" });
    },
  );

  it("accepts a real EIP-191 signature and rejects a tampered message", async () => {
    rpcMock((r) => (r.method === "eth_chainId" ? "0x1237" : "0x0"));
    const account = privateKeyToAccount(generatePrivateKey());
    const message = "muse #1 of MUSEGOD lives here.";
    const signature = await account.signMessage({ message });
    const chain = robinhoodMuseChain();
    expect(await chain.verifyMessage(account.address, message, signature)).toBe(
      true,
    );
    expect(
      await chain.verifyMessage(
        account.address,
        message + "changed",
        signature,
      ),
    ).toBe(false);
    expect(await chain.verifyMessage(account.address, message, "0x1234")).toBe(
      false,
    );
  });

  it("passes contract and ERC-6492 signatures through viem's deployless verifier", async () => {
    const message = "Confirm Bard's home";
    const signatures: Hex[] = [
      "0x1234",
      serializeErc6492Signature({
        address: stranger,
        data: "0x1234",
        signature: "0xabcd",
      }),
    ];
    const requests = rpcMock((r) =>
      r.method === "eth_chainId" ? "0x1237" : "0x1",
    );
    const chain = robinhoodMuseChain();
    for (const signature of signatures) {
      expect(await chain.verifyMessage(owner, message, signature)).toBe(true);
      const call = requests.at(-1)!.params[0];
      expect(call.to).toBeUndefined();
      expect(call.data).toContain(hashMessage(message).slice(2));
      expect(call.data).toContain(signature.slice(2));
    }
    expect(requests.filter((r) => r.method === "eth_call")).toHaveLength(2);
  });

  it("rejects signature checks when the chain cannot be verified", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("offline");
      }),
    );
    const account = privateKeyToAccount(generatePrivateKey());
    const message = "Muse signature";
    const signature = await account.signMessage({ message });
    const chain = robinhoodMuseChain();
    for (const [address, value] of [
      [account.address, signature],
      [owner, "0x1234"],
    ] as const)
      await expect(
        chain.verifyMessage(address, message, value),
      ).rejects.toMatchObject({ status: 503, code: "RPC_UNAVAILABLE" });
  });
});
