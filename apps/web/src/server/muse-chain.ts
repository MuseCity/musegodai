import {
  createPublicClient,
  http,
  createTransport,
  BaseError,
  HttpRequestError,
  RpcRequestError,
  TimeoutError,
  ExecutionRevertedError,
  type Address,
  type EIP1193RequestFn,
} from "viem";
import { robinhood } from "../shared/chains";
import { ApiError, requireValue } from "./errors";
import {
  robinhoodEndpoints,
  retryableRpc,
  coolDownRpc,
  rpcAttempt,
  logRpcFailure,
  type RpcAttempt,
  hasVerifiedRpcChain,
  rememberRpcChain,
} from "./rpc";

export type MuseChain = {
  verifyMessage(
    address: string,
    message: string,
    signature: `0x${string}`,
  ): Promise<boolean>;
};
type ReadDiagnostics = {
  attempts: RpcAttempt[];
  endpoint?: string;
  failed: boolean;
};

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
  const chainChecks = new Map<string, Promise<void>>();
  const makeClient = (
    diagnostics: ReadDiagnostics,
    onError?: (error: unknown) => void,
  ) =>
    createPublicClient({
      chain: robinhood,
      batch: { multicall: false },
      transport: (options) =>
        createTransport({
          key: "robinhood",
          name: "Robinhood RPC",
          type: "http",
          retryCount: 0,
          request: (async (args, requestOptions) => {
            // Re-select for each read so this client also observes a new cooldown.
            const endpoints = robinhoodEndpoints(rpcUrl);
            for (const [index, endpoint] of endpoints.entries()) {
              diagnostics.endpoint = endpoint;
              diagnostics.failed = false;
              try {
                const transport = http(endpoint, {
                  batch: false,
                  timeout: 8_000,
                  retryCount: 0,
                  onFetchResponse(response) {
                    if (!response.ok)
                      throw Object.assign(
                        new Error("RPC HTTP request failed."),
                        {
                          status: response.status,
                        },
                      );
                  },
                })(options);
                if (!hasVerifiedRpcChain(endpoint, robinhood.id)) {
                  let check = chainChecks.get(endpoint);
                  if (!check) {
                    check = transport
                      .request({ method: "eth_chainId" })
                      .then((id) => {
                        requireValue(
                          typeof id === "string" &&
                            /^0x[0-9a-f]+$/i.test(id) &&
                            BigInt(id) === BigInt(robinhood.id),
                          503,
                          "RPC_UNAVAILABLE",
                          "Wrong network.",
                        );
                        rememberRpcChain(endpoint, robinhood.id);
                      })
                      .finally(() => {
                        chainChecks.delete(endpoint);
                      });
                    chainChecks.set(endpoint, check);
                  }
                  await check;
                }
                if (args.method === "eth_chainId")
                  return `0x${robinhood.id.toString(16)}`;
                return await transport.request(args, requestOptions);
              } catch (error) {
                diagnostics.failed = true;
                diagnostics.attempts.push(rpcAttempt(endpoint, error));
                if (!(error instanceof ApiError) && retryableRpc(error)) {
                  coolDownRpc(endpoint, error);
                  if (index < endpoints.length - 1) continue;
                }
                onError?.(error);
                throw error;
              }
            }
            throw unavailable();
          }) as EIP1193RequestFn,
        }),
    });
  async function read<T>(
    operation: (client: ReturnType<typeof makeClient>) => Promise<T>,
    onError?: (error: unknown) => void,
  ): Promise<T> {
    const diagnostics: ReadDiagnostics = { attempts: [], failed: false };
    const client = makeClient(diagnostics, onError);
    try {
      await client.getChainId();
      return await operation(client);
    } catch (error) {
      if (!diagnostics.failed && diagnostics.endpoint)
        diagnostics.attempts.push(rpcAttempt(diagnostics.endpoint, error));
      logRpcFailure(diagnostics.attempts);
      // Do not expose RPC URLs, credentials, payloads or wallet addresses.
      throw unavailable();
    }
  }

  return {
    verifyMessage: (address, message, signature) => {
      let rpcFailed = false;
      return read(
        async (client) => {
          let valid = false;
          try {
            valid = await client.verifyMessage({
              address: address as Address,
              message,
              signature,
            });
          } catch {
            // Malformed and non-matching signatures are ordinary invalid proofs.
          }
          if (rpcFailed) throw unavailable();
          return valid;
        },
        (error) => {
          // viem can catch call failures while trying EOA recovery. Observe the
          // transport per verification so an outage cannot become "invalid".
          if (
            error instanceof ApiError ||
            (error instanceof BaseError &&
              error.walk(
                (cause) =>
                  cause instanceof HttpRequestError ||
                  cause instanceof TimeoutError ||
                  (cause instanceof RpcRequestError &&
                    cause.code !== ExecutionRevertedError.code &&
                    !ExecutionRevertedError.nodeMessage.test(
                      cause.details.toLowerCase(),
                    )),
              ) instanceof BaseError)
          )
            rpcFailed = true;
        },
      );
    },
  };
}
