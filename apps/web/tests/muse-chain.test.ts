import { afterEach, describe, expect, it, vi } from "vitest";
import {
  decodeFunctionData,
  encodeAbiParameters,
  erc721Abi,
  hashMessage,
  parseAbi,
  serializeErc6492Signature,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { robinhoodMuseChain } from "../src/server/muse-chain";
import { adapter8004, museContract } from "../src/shared/muses";

const owner = "0xaabbccddeeff00112233445566778899aabbccdd";
const stranger = "0x2222222222222222222222222222222222222222";
const adapterAbi = parseAbi([
  "function isController(uint256 agentId, address controller) view returns (bool)",
  "function bindingOf(uint256 agentId) view returns (uint8, address, uint256)",
]);
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
const bool = (value: boolean) =>
  encodeAbiParameters([{ type: "bool" }], [value]);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Robinhood muse chain reads", () => {
  it("decodes ownership and immutable agent binding at the shared contracts", async () => {
    const requests = rpcMock((request) => {
      if (request.method === "eth_chainId") return "0x1237";
      const call = request.params[0];
      expect(request.params[1]).toBe("latest");
      if (call.to?.toLowerCase() === museContract) {
        expect(decodeFunctionData({ abi: erc721Abi, data: call.data })).toEqual(
          {
            functionName: "ownerOf",
            args: [1n],
          },
        );
        return encodeAbiParameters([{ type: "address" }], [owner]);
      }
      expect(call.to?.toLowerCase()).toBe(adapter8004);
      expect(decodeFunctionData({ abi: adapterAbi, data: call.data })).toEqual({
        functionName: "bindingOf",
        args: [6592n],
      });
      return encodeAbiParameters(
        [{ type: "uint8" }, { type: "address" }, { type: "uint256" }],
        [0, museContract, 1n],
      );
    });
    const chain = robinhoodMuseChain();
    expect(await chain.ownerOf(1)).toBe(owner);
    expect(await chain.bindingOf(6592)).toEqual({
      standard: 0,
      contract: museContract,
      tokenId: 1,
    });
    expect(requests.filter((r) => r.method === "eth_chainId")).toHaveLength(1);
  });

  it("caches owners and both controller outcomes for 60 seconds by lookup", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-29T00:00:00Z"));
    let holder = owner;
    const requests = rpcMock((request) => {
      if (request.method === "eth_chainId") return "0x1237";
      const call = request.params[0];
      if (call.to?.toLowerCase() === museContract)
        return encodeAbiParameters([{ type: "address" }], [holder as Hex]);
      expect(call.to?.toLowerCase()).toBe(adapter8004);
      const decoded = decodeFunctionData({ abi: adapterAbi, data: call.data });
      expect(decoded.functionName).toBe("isController");
      return bool(
        decoded.args[0] === 6592n &&
          String(decoded.args[1]).toLowerCase() === owner,
      );
    });
    const chain = robinhoodMuseChain();
    expect(await chain.ownerOf(1)).toBe(owner);
    expect(await chain.ownerOf(2)).toBe(owner);
    expect(await chain.isController(6592, owner)).toBe(true);
    expect(await chain.isController(6592, stranger)).toBe(false);
    expect(await chain.isController(6593, owner)).toBe(false);
    expect(
      await chain.isController(6592, "0x" + owner.slice(2).toUpperCase()),
    ).toBe(true);
    holder = stranger;
    vi.setSystemTime(Date.now() + 59_999);
    expect(await chain.ownerOf(1)).toBe(owner);
    expect(await chain.isController(6592, stranger)).toBe(false);
    expect(requests.filter((r) => r.method === "eth_call")).toHaveLength(5);
    vi.setSystemTime(Date.now() + 1);
    expect(await chain.ownerOf(1)).toBe(stranger);
    expect(await chain.isController(6592, stranger)).toBe(false);
    expect(requests.filter((r) => r.method === "eth_call")).toHaveLength(7);
    expect(requests.filter((r) => r.method === "eth_chainId")).toHaveLength(1);
  });

  it("shares one chain check for concurrent reads but isolates service instances", async () => {
    const requests = rpcMock((r) =>
      r.method === "eth_chainId" ? "0x1237" : bool(true),
    );
    const first = robinhoodMuseChain();
    await Promise.all([
      first.isController(6592, owner),
      first.isController(6592, stranger),
    ]);
    expect(requests.filter((r) => r.method === "eth_chainId")).toHaveLength(1);
    await robinhoodMuseChain().isController(6592, owner);
    expect(requests.filter((r) => r.method === "eth_chainId")).toHaveLength(2);
  });

  it("constructs with malformed or non-HTTPS configuration but rejects each read without fetching", async () => {
    const requests = rpcMock(() => "0x1237");
    for (const endpoint of [
      "http://rpc.example.test",
      "ws://rpc.example.test",
      "invalid",
    ]) {
      let chain!: ReturnType<typeof robinhoodMuseChain>;
      expect(() => (chain = robinhoodMuseChain(endpoint))).not.toThrow();
      for (const read of [
        () => chain.ownerOf(1),
        () => chain.isController(6592, owner),
        () => chain.bindingOf(6592),
        () => chain.verifyMessage(owner, "Bard", "0x1234"),
      ])
        await expect(read()).rejects.toMatchObject({
          status: 503,
          code: "RPC_UNAVAILABLE",
        });
    }
    expect(requests).toHaveLength(0);
  });

  it("rejects a wrong chain for reads and even an otherwise valid EOA signature", async () => {
    const requests = rpcMock(() => "0x2105");
    const account = privateKeyToAccount(generatePrivateKey());
    const signature = await account.signMessage({ message: "Muse ownership" });
    const chain = robinhoodMuseChain();
    await expect(chain.ownerOf(1)).rejects.toMatchObject({
      status: 503,
      code: "RPC_UNAVAILABLE",
    });
    await expect(
      chain.verifyMessage(account.address, "Muse ownership", signature),
    ).rejects.toMatchObject({ status: 503, code: "RPC_UNAVAILABLE" });
    expect(requests.every((r) => r.method === "eth_chainId")).toBe(true);
  });

  it("maps network, HTTP, RPC and malformed results to a stable error without retries", async () => {
    for (const result of ["offline", "http", "rpc", "malformed"] as const) {
      let calls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          calls++;
          const request = JSON.parse(
            String(input instanceof Request ? await input.text() : init?.body),
          );
          if (request.method === "eth_chainId")
            return Response.json({
              jsonrpc: "2.0",
              id: request.id,
              result: "0x1237",
            });
          if (result === "offline") throw new TypeError("offline");
          if (result === "http") return new Response(null, { status: 503 });
          return Response.json({
            jsonrpc: "2.0",
            id: request.id,
            ...(result === "rpc"
              ? { error: { code: -32603, message: "unavailable" } }
              : { result: "0x" }),
          });
        }),
      );
      await expect(
        robinhoodMuseChain("https://rpc.example.test").ownerOf(1),
      ).rejects.toMatchObject({ status: 503, code: "RPC_UNAVAILABLE" });
      expect(calls).toBe(2);
    }
  });

  it("does not retain a failed lookup in its result cache", async () => {
    let available = false;
    rpcMock((r) => {
      if (r.method === "eth_chainId") return "0x1237";
      return available
        ? encodeAbiParameters([{ type: "address" }], [owner])
        : "0x";
    });
    const chain = robinhoodMuseChain();
    await expect(chain.ownerOf(1)).rejects.toMatchObject({
      code: "RPC_UNAVAILABLE",
    });
    available = true;
    expect(await chain.ownerOf(1)).toBe(owner);
  });
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
