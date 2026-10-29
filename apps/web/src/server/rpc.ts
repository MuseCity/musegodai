export const publicRobinhoodRpc = "https://rpc.mainnet.chain.robinhood.com";
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

export function logRpcFallback(error: unknown) {
  const causes = rpcCauses(error);
  console.warn(
    JSON.stringify({
      event: "rpc.fallback",
      from: "configured",
      status: causes.find((cause) => cause.status !== undefined)?.status,
      code: causes.find((cause) => cause.code !== undefined)?.code,
    }),
  );
}

export function robinhoodEndpoints(rpcUrl?: string): string[] {
  try {
    if (rpcUrl && new URL(rpcUrl).protocol === "https:")
      return [...new Set([rpcUrl, publicRobinhoodRpc])];
  } catch {
    // Invalid optional configuration leaves the public endpoint available.
  }
  return [publicRobinhoodRpc];
}

export function retryableRpc(error: unknown): boolean {
  const seen = new Set<unknown>();
  while (error && typeof error === "object" && !seen.has(error)) {
    seen.add(error);
    const cause = error as {
      status?: unknown;
      code?: unknown;
      name?: string;
      cause?: unknown;
    };
    if (typeof cause.status === "number")
      return (
        cause.status === 429 || (cause.status >= 500 && cause.status <= 599)
      );
    if (cause.code === 429 || networkCodes.has(String(cause.code))) return true;
    if (
      error instanceof TypeError ||
      cause.name === "TimeoutError" ||
      cause.name === "AbortError"
    )
      return true;
    error = cause.cause;
  }
  return false;
}
