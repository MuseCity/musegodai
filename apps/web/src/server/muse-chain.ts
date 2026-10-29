import {
  createPublicClient,
  erc721Abi,
  http,
  parseAbi,
  type Address,
} from "viem";
import { robinhood } from "../shared/chains";
import { adapter8004, museContract } from "../shared/muses";
import { ApiError, requireValue } from "./errors";

export type MuseChain = {
  ownerOf(tokenId: number): Promise<string>;
  isController(agentId: number, address: string): Promise<boolean>;
  bindingOf(agentId: number): Promise<{
    standard: number;
    contract: string;
    tokenId: number;
  }>;
  verifyMessage(
    address: string,
    message: string,
    signature: `0x${string}`,
  ): Promise<boolean>;
};

const adapterAbi = parseAbi([
  "function isController(uint256 agentId, address controller) view returns (bool)",
  "function bindingOf(uint256 agentId) view returns (uint8, address, uint256)",
]);
const cacheTtl = 60_000;
type Cached<T> = { value: T; expiresAt: number };

function unavailable() {
  return new ApiError(
    503,
    "RPC_UNAVAILABLE",
    "Muse ownership could not be checked right now. Please retry.",
  );
}

export function robinhoodMuseChain(rpcUrl?: string): MuseChain {
  const endpoint = rpcUrl || robinhood.rpcUrls.default.http[0];
  try {
    if (new URL(endpoint).protocol !== "https:") throw unavailable();
  } catch {
    throw unavailable();
  }
  // Keep the client instance request-scoped. Never combine I/O belonging to
  // different Cloudflare Worker request contexts in a shared batch scheduler.
  const client = createPublicClient({
    chain: robinhood,
    batch: { multicall: false },
    transport: http(endpoint, { batch: false, timeout: 8_000, retryCount: 0 }),
  });
  let chainChecked: Promise<void> | undefined;
  const owners = new Map<number, Cached<string>>();
  const controllers = new Map<string, Cached<boolean>>();

  async function read<T>(operation: () => Promise<T>): Promise<T> {
    try {
      chainChecked ??= client.getChainId().then((chainId) => {
        requireValue(
          chainId === robinhood.id,
          503,
          "RPC_UNAVAILABLE",
          "Wrong network.",
        );
      });
      await chainChecked;
      return await operation();
    } catch {
      // Do not expose RPC URLs, credentials, payloads or wallet addresses.
      throw unavailable();
    }
  }

  return {
    async ownerOf(tokenId) {
      const cached = owners.get(tokenId);
      if (cached && cached.expiresAt > Date.now()) return cached.value;
      const value = await read(async () =>
        (
          await client.readContract({
            address: museContract,
            abi: erc721Abi,
            functionName: "ownerOf",
            args: [BigInt(tokenId)],
          })
        ).toLowerCase(),
      );
      owners.set(tokenId, { value, expiresAt: Date.now() + cacheTtl });
      return value;
    },
    async isController(agentId, address) {
      const controller = address.toLowerCase() as Address;
      const key = `${agentId}:${controller}`;
      const cached = controllers.get(key);
      if (cached && cached.expiresAt > Date.now()) return cached.value;
      const value = await read(() =>
        client.readContract({
          address: adapter8004,
          abi: adapterAbi,
          functionName: "isController",
          args: [BigInt(agentId), controller],
        }),
      );
      controllers.set(key, { value, expiresAt: Date.now() + cacheTtl });
      return value;
    },
    bindingOf: (agentId) =>
      read(async () => {
        const [standard, contract, token] = await client.readContract({
          address: adapter8004,
          abi: adapterAbi,
          functionName: "bindingOf",
          args: [BigInt(agentId)],
        });
        const tokenId = Number(token);
        requireValue(
          Number.isSafeInteger(tokenId),
          503,
          "RPC_UNAVAILABLE",
          "Invalid muse binding.",
        );
        return { standard, contract: contract.toLowerCase(), tokenId };
      }),
    verifyMessage: (address, message, signature) =>
      read(() =>
        client.verifyMessage({
          address: address as Address,
          message,
          signature,
        }),
      ),
  };
}
