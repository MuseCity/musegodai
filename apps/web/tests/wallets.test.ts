import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeFunctionData, erc20Abi } from "viem";
import {
  linkedEvmAddresses,
  privyWalletServices,
  qualificationWallet,
} from "../src/server/wallets";
import { governanceRules } from "../src/shared/governance";
import {
  transferRequest,
  walletError,
  type Transfer,
} from "../src/shared/wallet";
import {
  walletAssets,
  prepareTransfer,
  transactionStatus,
  switchWalletChain,
} from "../src/components/wallet-network";
const owner = "0x1111111111111111111111111111111111111111";
const recipient = "0x2222222222222222222222222222222222222222";
const linked = {
  type: "wallet",
  chain_type: "ethereum",
  connector_type: "embedded",
  wallet_client_type: "privy",
  imported: false,
  wallet_index: 0,
  id: "local-wallet",
  address: owner,
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const transfer: Transfer = {
  chainId: 4663,
  asset: {
    address: null,
    symbol: "ETH",
    decimals: 18,
    balance: "2000000000000000000",
  },
  recipient,
  amount: "0.1",
};
function rpcMock(
  handler: (request: { method: string; params: any[] }) => unknown,
) {
  return vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init: RequestInit) => {
      const request = JSON.parse(String(init.body));
      const reply = (request: {
        id: number;
        method: string;
        params: any[];
      }) => ({
        jsonrpc: "2.0",
        id: request.id,
        result: handler(request),
      });
      return Response.json(
        Array.isArray(request) ? request.map(reply) : reply(request),
      );
    }),
  );
}
describe("wallet provenance and current on-chain qualification", () => {
  it("keeps all verified top-level linked EVM wallets separately from qualification", () => {
    const external = "0xaabbccddeeff00112233445566778899aabbccdd";
    expect(
      linkedEvmAddresses(
        {
          id: "did:privy:alice",
          linked_accounts: [
            linked,
            {
              type: "wallet",
              chain_type: "ethereum",
              connector_type: "injected",
              address: "0x" + external.slice(2).toUpperCase(),
            },
            { type: "wallet", chain_type: "ethereum", address: external },
            {
              type: "wallet",
              chain_type: "ethereum",
              connector_type: "delegate",
              address: recipient,
            },
            { ...linked, chain_type: "solana" },
            { type: "email", address: external },
            { type: "cross_app", embedded_wallets: [linked] },
            { type: "wallet", chain_type: "ethereum", address: "invalid" },
            null,
            "wallet",
          ],
        },
        "did:privy:alice",
      ),
    ).toEqual([owner, external, recipient]);
  });
  it("rejects linked wallet identity mismatches with the existing stable error", () => {
    expect(() =>
      linkedEvmAddresses(
        { id: "did:privy:bob", linked_accounts: [linked] },
        "did:privy:alice",
      ),
    ).toThrowError(
      expect.objectContaining({ status: 503, code: "WALLET_UNAVAILABLE" }),
    );
  });
  it("reads linked addresses through the existing verified Privy user API", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          id: "did:privy:alice",
          linked_accounts: [
            linked,
            { type: "wallet", chain_type: "ethereum", address: recipient },
          ],
        }),
      ),
    );
    const services = privyWalletServices("local-app", "local-secret");
    expect(await services.linkedAddresses("did:privy:alice")).toEqual([
      owner,
      recipient,
    ]);
    expect(fetch).toHaveBeenCalledTimes(1);
    const input = vi.mocked(fetch).mock.calls[0]![0];
    const url = input instanceof Request ? input.url : String(input);
    expect(new URL(url).pathname).toBe("/v1/users/did:privy:alice");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ id: "did:privy:bob", linked_accounts: [linked] }),
      ),
    );
    await expect(
      services.linkedAddresses("did:privy:alice"),
    ).rejects.toMatchObject({ status: 503, code: "WALLET_UNAVAILABLE" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("offline");
      }),
    );
    await expect(
      services.linkedAddresses("did:privy:alice"),
    ).rejects.toMatchObject({ status: 503, code: "WALLET_UNAVAILABLE" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("accepts only the app-scoped non-imported primary embedded EVM wallet", () => {
    const user = (wallet: unknown) => ({
      id: "did:privy:alice",
      linked_accounts: [wallet],
    });
    expect(qualificationWallet(user(linked), "did:privy:alice")).toEqual({
      id: "local-wallet",
      address: owner,
    });
    for (const invalid of [
      { imported: true },
      { imported: undefined },
      { connector_type: "injected" },
      { wallet_client_type: "metamask" },
      { chain_type: "solana" },
      { wallet_index: 1 },
      { id: null },
      { address: "invalid" },
    ])
      expect(
        qualificationWallet(user({ ...linked, ...invalid }), "did:privy:alice"),
      ).toBeNull();
    expect(
      qualificationWallet(
        user({ type: "cross_app", embedded_wallets: [linked] }),
        "did:privy:alice",
      ),
    ).toBeNull();
    expect(() => qualificationWallet(user(linked), "did:privy:bob")).toThrow();
    expect(() =>
      qualificationWallet(
        { id: "did:privy:alice", linked_accounts: [linked, linked] },
        "did:privy:alice",
      ),
    ).toThrow();
  });
  it("queries the exact Robinhood token at latest, and rejects wrong-chain RPC responses", async () => {
    const requests: { method: string; params: any[] }[] = [];
    rpcMock((r) => {
      requests.push(r);
      return r.method === "eth_chainId"
        ? "0x1237"
        : "0x" +
            BigInt(governanceRules.threshold).toString(16).padStart(64, "0");
    });
    const service = privyWalletServices("local-app", "local-secret");
    expect(await service.balance(owner, governanceRules)).toBe(
      BigInt(governanceRules.threshold),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(
      JSON.parse(String(vi.mocked(fetch).mock.calls[0]![1]!.body)),
    ).toHaveLength(2);
    const call = requests.find((r) => r.method === "eth_call")!;
    expect(call.params[0].to.toLowerCase()).toBe(
      governanceRules.tokenAddress.toLowerCase(),
    );
    expect(call.params[0].data).toBe(
      "0x70a08231" + owner.slice(2).padStart(64, "0"),
    );
    expect(call.params[1]).toBe("latest");
    rpcMock(() => "0x2105");
    await expect(service.balance(owner, governanceRules)).rejects.toMatchObject(
      { code: "RPC_UNAVAILABLE" },
    );
  });
  it("matches batch responses by id and rejects partial, duplicate, and rate-limited results", async () => {
    const service = privyWalletServices("local-app", "local-secret");
    const chain = { jsonrpc: "2.0", id: 1, result: "0x1237" };
    const balance = {
      jsonrpc: "2.0",
      id: 2,
      result:
        "0x" + BigInt(governanceRules.threshold).toString(16).padStart(64, "0"),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json([balance, chain])),
    );
    expect(await service.balance(owner, governanceRules)).toBe(
      BigInt(governanceRules.threshold),
    );
    for (const replies of [
      [chain],
      [chain, chain],
      [
        chain,
        {
          jsonrpc: "2.0",
          id: 2,
          error: { code: 429, message: "rate limited" },
        },
      ],
    ]) {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => Response.json(replies)),
      );
      await expect(
        service.balance(owner, governanceRules),
      ).rejects.toMatchObject({ code: "RPC_UNAVAILABLE" });
    }
  });
  it("does not treat malformed balances or RPC errors as zero", async () => {
    const service = privyWalletServices("local-app", "local-secret");
    rpcMock((r) => (r.method === "eth_chainId" ? "0x1237" : "0x"));
    await expect(service.balance(owner, governanceRules)).rejects.toMatchObject(
      { code: "RPC_UNAVAILABLE" },
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    await expect(service.balance(owner, governanceRules)).rejects.toMatchObject(
      { code: "RPC_UNAVAILABLE" },
    );
  });
  it("uses a server-configured HTTPS endpoint without falling back on errors", async () => {
    rpcMock((r) =>
      r.method === "eth_chainId" ? "0x1237" : "0x" + "0".repeat(64),
    );
    const endpoint = "https://rpc.example.test/private-endpoint";
    expect(
      await privyWalletServices("local-app", "local-secret", endpoint).balance(
        owner,
        governanceRules,
      ),
    ).toBe(0n);
    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe(endpoint);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("rate limited", { status: 429 })),
    );
    await expect(
      privyWalletServices("local-app", "local-secret", endpoint).balance(
        owner,
        governanceRules,
      ),
    ).rejects.toMatchObject({ code: "RPC_UNAVAILABLE" });
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(
      privyWalletServices(
        "local-app",
        "local-secret",
        "http://rpc.example.test",
      ).balance(owner, governanceRules),
    ).rejects.toMatchObject({ code: "RPC_UNAVAILABLE" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
describe("wallet transfer safety and status", () => {
  it("waits for the updated Privy wallet and does not reuse its stale provider", async () => {
    vi.useFakeTimers();
    const oldProvider = vi.fn();
    let current: any = {
      address: owner,
      chainId: "eip155:4663",
      switchChain: vi.fn(async () => {}),
      getEthereumProvider: oldProvider,
    };
    const change = switchWalletChain(() => current, 8453);
    await vi.advanceTimersByTimeAsync(0);
    const request = vi.fn(async () => "0x2105");
    current = {
      ...current,
      chainId: "eip155:8453",
      getEthereumProvider: vi.fn(async () => ({ request })),
    };
    await vi.advanceTimersByTimeAsync(100);
    await change;
    expect(oldProvider).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith({ method: "eth_chainId" });
    current = { ...current, chainId: "eip155:4663" };
    const interrupted = expect(
      switchWalletChain(() => current, 8453),
    ).rejects.toThrow("account changed");
    await vi.advanceTimersByTimeAsync(0);
    current = undefined;
    await vi.advanceTimersByTimeAsync(100);
    await interrupted;
  });
  it("encodes exact ETH and ERC20 base units without floating-point rounding", () => {
    expect(transferRequest(transfer)).toMatchObject({
      chainId: 4663,
      to: recipient,
      value: 100000000000000000n,
    });
    const token = transferRequest({
      ...transfer,
      asset: {
        address: governanceRules.tokenAddress,
        symbol: "MUSEGOD",
        decimals: 18,
        balance: governanceRules.threshold,
      },
      amount: "99999.999999999999999999",
    });
    expect(token.value).toBe(0n);
    expect(
      decodeFunctionData({ abi: erc20Abi, data: token.data! }),
    ).toMatchObject({
      functionName: "transfer",
      args: [recipient, BigInt(governanceRules.threshold) - 1n],
    });
  });
  it("rejects invalid recipients, amounts, excess precision, balance and unsupported networks", () => {
    for (const amount of [
      "0",
      "-1",
      "1e2",
      "NaN",
      ".1",
      "0.0000000000000000001",
      "3",
    ])
      expect(() => transferRequest({ ...transfer, amount })).toThrow();
    for (const value of [
      "invalid",
      "0x0000000000000000000000000000000000000000",
    ])
      expect(() =>
        transferRequest({ ...transfer, recipient: value }),
      ).toThrow();
    expect(() =>
      transferRequest({ ...transfer, chainId: 1 as 4663 }),
    ).toThrow();
    expect(walletError(new Error("User rejected request 4001"))).toContain(
      "cancelled",
    );
  });
  it("checks selected network, native balances and gas before signing", async () => {
    rpcMock((r) =>
      r.method === "eth_chainId"
        ? "0x2105"
        : r.method === "eth_getBalance"
          ? "0x16345785d8a0000"
          : r.method === "eth_estimateGas"
            ? "0x5208"
            : "0x3b9aca00",
    );
    expect(await walletAssets(owner, 8453)).toEqual([
      {
        address: null,
        symbol: "ETH",
        decimals: 18,
        balance: "100000000000000000",
      },
    ]);
    await expect(
      prepareTransfer(owner, { ...transfer, chainId: 8453 }),
    ).rejects.toThrow("Insufficient funds");
    await expect(
      prepareTransfer(owner, { ...transfer, chainId: 8453, amount: "0.01" }),
    ).resolves.toMatchObject({ chainId: 8453, value: 10000000000000000n });
    await expect(walletAssets(owner, 4663)).rejects.toThrow("wrong network");
  });
  it("distinguishes pending, confirmed, reverted and an unavailable status lookup", async () => {
    const hash = ("0x" + "1".repeat(64)) as `0x${string}`;
    rpcMock((r) => (r.method === "eth_chainId" ? "0x2105" : null));
    expect(await transactionStatus(8453, hash)).toBe("pending");
    for (const status of ["0x1", "0x0"]) {
      rpcMock((r) =>
        r.method === "eth_chainId"
          ? "0x2105"
          : { status, transactionHash: hash, logs: [] },
      );
      expect(await transactionStatus(8453, hash)).toBe(
        status === "0x1" ? "confirmed" : "reverted",
      );
    }
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );
    await expect(transactionStatus(8453, hash)).rejects.toThrow();
  });
});
