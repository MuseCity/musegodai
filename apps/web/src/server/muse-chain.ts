import {
  createPublicClient,
  erc721Abi,
  http,
  fallback,
  parseAbi,
  parseAbiItem,
  BaseError,
  HttpRequestError,
  RpcRequestError,
  TimeoutError,
  ExecutionRevertedError,
  type Address,
} from "viem";
import { robinhood } from "../shared/chains";
import { adapter8004, museContract } from "../shared/muses";
import { ApiError, requireValue } from "./errors";
import { robinhoodEndpoints, retryableRpc, logRpcFallback } from "./rpc";

export type MuseChain = {
  headBlock(): Promise<bigint>;
  transferredTokens(fromBlock: bigint, toBlock: bigint): Promise<number[]>;
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
  // Keep the client instance request-scoped. Never combine I/O belonging to
  // different Cloudflare Worker request contexts in a shared batch scheduler.
  const makeClient = (onError?: (error: unknown) => void) =>
    createPublicClient({
      chain: robinhood,
      batch: { multicall: false },
      transport: (options) => {
        const endpoints = robinhoodEndpoints(rpcUrl);
        const transport = fallback(
          endpoints.map((endpoint) =>
            http(endpoint, {
              batch: false,
              timeout: 8_000,
              retryCount: 0,
              // viem otherwise prefers a JSON-RPC error body over HTTP status.
              // Keep 429/5xx eligible for fallback regardless of that body.
              onFetchResponse(response) {
                if (!response.ok)
                  throw Object.assign(new Error("RPC HTTP request failed."), {
                    status: response.status,
                  });
              },
            }),
          ),
          {
            rank: false,
            retryCount: 0,
            shouldThrow: (error) => !retryableRpc(error),
          },
        )(options);
        transport.value?.onResponse(({ status, error, transport: source }) => {
          if (
            status === "error" &&
            endpoints.length > 1 &&
            source.value?.url === endpoints[0] &&
            retryableRpc(error)
          )
            logRpcFallback(error);
        });
        const request = ((...args: Parameters<typeof transport.request>) =>
          transport.request(...args).catch((error: unknown) => {
            onError?.(error);
            throw error;
          })) as typeof transport.request;
        return { ...transport, request };
      },
    });
  const client = makeClient();
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
    headBlock: () => read(() => client.getBlockNumber({ cacheTime: 0 })),
    transferredTokens: (fromBlock, toBlock) =>
      read(async () => {
        const logs = await client.getLogs({
          address: museContract,
          event: parseAbiItem(
            "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
          ),
          fromBlock,
          toBlock,
          strict: true,
        });
        return [
          ...new Set(
            logs
              .map((log) => Number(log.args.tokenId))
              .filter((id) => Number.isInteger(id) && id >= 1 && id <= 999),
          ),
        ];
      }),
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
      read(async () => {
        // viem can catch call failures while trying EOA recovery. Observe the
        // transport per verification so an outage cannot become "invalid".
        let rpcFailed = false;
        const verifier = makeClient((error) => {
          if (
            error instanceof BaseError &&
            error.walk(
              (cause) =>
                cause instanceof HttpRequestError ||
                cause instanceof TimeoutError ||
                (cause instanceof RpcRequestError &&
                  cause.code !== ExecutionRevertedError.code &&
                  !ExecutionRevertedError.nodeMessage.test(
                    cause.details.toLowerCase(),
                  )),
            ) instanceof BaseError
          )
            rpcFailed = true;
        });
        let valid = false;
        try {
          valid = await verifier.verifyMessage({
            address: address as Address,
            message,
            signature,
          });
        } catch {
          // Malformed and non-matching signatures are ordinary invalid proofs.
        }
        if (rpcFailed) throw unavailable();
        return valid;
      }),
  };
}
