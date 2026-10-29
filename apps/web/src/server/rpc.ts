export const publicRobinhoodRpc = "https://rpc.mainnet.chain.robinhood.com";
export const publicRobinhoodRpcs = [
  publicRobinhoodRpc,
  "https://robinhood.drpc.org",
  "https://robinhood-rpc.publicnode.com",
] as const;
// Isolate-local plain values only. Never retain request I/O or promises here.
const cooldowns = new Map<string, number>();
const verifiedChains = new Map<string, number>();

export function hasVerifiedRpcChain(endpoint: string, chainId: number) {
  return verifiedChains.get(new URL(endpoint).href) === chainId;
}

export function rememberRpcChain(endpoint: string, chainId: number) {
  verifiedChains.set(new URL(endpoint).href, chainId);
}

export type RpcAttempt = {
  endpoint: "configured" | "public-1" | "public-2" | "public-3";
  status?: number;
  code?: number | string;
  name: string;
};

export function rpcAttempt(endpoint: string, error: unknown): RpcAttempt {
  const index = publicRobinhoodRpcs.findIndex(
    (url) => new URL(url).href === new URL(endpoint).href,
  );
  const causes = rpcCauses(error);
  return {
    endpoint:
      index < 0
        ? "configured"
        : (`public-${index + 1}` as RpcAttempt["endpoint"]),
    status: causes.find((cause) => cause.status !== undefined)?.status,
    code: causes.find((cause) => cause.code !== undefined)?.code,
    name: causes[0]?.name ?? "Error",
  };
}

export function coolDownRpc(endpoint: string, error: unknown) {
  const key = new URL(endpoint).href;
  if (Date.now() < (cooldowns.get(key) ?? 0)) return;
  cooldowns.set(key, Date.now() + 10 * 60_000);
  console.warn(
    JSON.stringify({ event: "rpc.fallback", ...rpcAttempt(endpoint, error) }),
  );
}

export function logRpcFailure(attempts: RpcAttempt[]) {
  console.error(JSON.stringify({ event: "rpc.failed", attempts }));
}
const networkCodes = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);
const errorNames = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "TimeoutError",
  "AbortError",
  "HttpRequestError",
  "RpcRequestError",
  "LimitExceededRpcError",
  "InternalRpcError",
  "UnknownRpcError",
  "InvalidInputRpcError",
  "ExecutionRevertedError",
  "CallExecutionError",
  "ContractFunctionExecutionError",
  "AbiDecodingDataSizeTooSmallError",
]);

export function rpcCauses(error: unknown) {
  // Provider-controlled strings may contain credentials; retain fixed labels only.
  const causes: { name: string; status?: number; code?: number | string }[] =
    [];
  const seen = new Set<unknown>();
  while (
    error &&
    typeof error === "object" &&
    !seen.has(error) &&
    causes.length < 5
  ) {
    seen.add(error);
    const cause = error as Record<string, unknown>;
    causes.push({
      name:
        typeof cause.name === "string" && errorNames.has(cause.name)
          ? cause.name
          : "Error",
      status:
        typeof cause.status === "number" &&
        Number.isInteger(cause.status) &&
        cause.status >= 100 &&
        cause.status <= 599
          ? cause.status
          : undefined,
      code:
        (typeof cause.code === "number" && Number.isSafeInteger(cause.code)) ||
        (typeof cause.code === "string" &&
          (networkCodes.has(cause.code) || cause.code === "RPC_UNAVAILABLE"))
          ? cause.code
          : undefined,
    });
    error = cause.cause;
  }
  return causes;
}

export function robinhoodEndpoints(rpcUrl?: string): string[] {
  const candidates: string[] = [...publicRobinhoodRpcs];
  try {
    if (rpcUrl && new URL(rpcUrl).protocol === "https:")
      candidates.unshift(rpcUrl);
  } catch {
    // Invalid optional configuration leaves the public endpoints available.
  }
  const seen = new Set<string>();
  const endpoints = candidates.filter((endpoint) => {
    const key = new URL(endpoint).href;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const available = endpoints.filter(
    (endpoint) => Date.now() >= (cooldowns.get(new URL(endpoint).href) ?? 0),
  );
  return available.length ? available : endpoints;
}

export function retryableRpc(error: unknown): boolean {
  const seen = new Set<unknown>();
  const causes: Record<string, unknown>[] = [];
  while (error && typeof error === "object" && !seen.has(error)) {
    seen.add(error);
    const cause = error as Record<string, unknown>;
    causes.push(cause);
    error = cause.cause;
  }
  // Reverts remain invalid proofs/reads even when their reason mentions a limit.
  const message = (cause: Record<string, unknown>) =>
    typeof cause.details === "string"
      ? cause.details
      : typeof cause.message === "string"
        ? cause.message
        : "";
  if (
    causes.some(
      (cause) =>
        cause.code === 3 ||
        cause.name === "ExecutionRevertedError" ||
        /execution reverted|gas required exceeds allowance/i.test(
          message(cause),
        ),
    )
  )
    return false;
  for (const cause of causes) {
    if (typeof cause.status === "number")
      return (
        [403, 408, 429].includes(cause.status) ||
        (cause.status >= 500 && cause.status <= 599)
      );
    if (
      cause.code === 429 ||
      cause.code === -32005 ||
      cause.code === -32603 ||
      (cause.code === -32000 &&
        /rate|limit|busy|capacity/i.test(message(cause))) ||
      networkCodes.has(String(cause.code)) ||
      cause.name === "LimitExceededRpcError" ||
      cause.name === "InternalRpcError"
    )
      return true;
    if (
      cause instanceof TypeError ||
      cause.name === "TimeoutError" ||
      cause.name === "AbortError"
    )
      return true;
  }
  return false;
}
