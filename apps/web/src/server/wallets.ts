import { PrivyClient } from "@privy-io/node";
import {
  decodeFunctionResult,
  encodeFunctionData,
  erc20Abi,
  isAddress,
  type Address,
} from "viem";
import { robinhood } from "../shared/chains";
import {
  governanceRules,
  type GovernanceRules,
  type Membership,
} from "../shared/governance";
import type { Database } from "./database";
import type { Actor } from "./auth";
import { ApiError, requireValue } from "./errors";

export type VerifiedWallet = NonNullable<Membership["wallet"]>;
export type WalletServices = {
  findWallet: (privyUserId: string) => Promise<VerifiedWallet | null>;
  balance: (address: string, rules: GovernanceRules) => Promise<bigint>;
};

// Only top-level app-scoped embedded wallets qualify. Cross-app wallets are
// nested in cross_app records, and imported/external wallets never pass this.
export function qualificationWallet(
  user: { id: string; linked_accounts: unknown[] },
  userId: string,
): VerifiedWallet | null {
  requireValue(
    user.id === userId,
    503,
    "WALLET_UNAVAILABLE",
    "Could not verify your wallet ownership.",
  );
  const wallets = user.linked_accounts.filter(
    (value): value is Record<string, unknown> => {
      if (!value || typeof value !== "object") return false;
      const w = value as Record<string, unknown>;
      return (
        w.type === "wallet" &&
        w.chain_type === "ethereum" &&
        w.connector_type === "embedded" &&
        w.wallet_client_type === "privy" &&
        w.imported === false &&
        w.wallet_index === 0 &&
        typeof w.id === "string" &&
        w.id.length > 0 &&
        typeof w.address === "string" &&
        isAddress(w.address)
      );
    },
  );
  requireValue(
    wallets.length <= 1,
    503,
    "WALLET_UNAVAILABLE",
    "Could not identify your musegod.ai wallet.",
  );
  const w = wallets[0];
  return w
    ? { id: w.id as string, address: (w.address as string).toLowerCase() }
    : null;
}

export function privyWalletServices(
  appId: string,
  appSecret: string,
  rpcUrl?: string,
): WalletServices {
  return {
    async findWallet(userId) {
      try {
        const client = new PrivyClient({
          appId,
          appSecret,
          timeout: 8000,
          maxRetries: 0,
        });
        return qualificationWallet(await client.users()._get(userId), userId);
      } catch {
        throw new ApiError(
          503,
          "WALLET_UNAVAILABLE",
          "Wallet verification is unavailable. Your vote has not changed. Please retry.",
        );
      }
    },
    async balance(address, rules) {
      try {
        // Keep the batch request-scoped. A shared scheduler can combine I/O
        // owned by different Cloudflare Worker request contexts.
        const endpoint = rpcUrl || robinhood.rpcUrls.default.http[0];
        requireValue(
          new URL(endpoint).protocol === "https:",
          503,
          "RPC_UNAVAILABLE",
          "A secure RPC endpoint is required.",
        );
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(8000),
          body: JSON.stringify([
            { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] },
            {
              jsonrpc: "2.0",
              id: 2,
              method: "eth_call",
              params: [
                {
                  to: rules.tokenAddress,
                  data: encodeFunctionData({
                    abi: erc20Abi,
                    functionName: "balanceOf",
                    args: [address as Address],
                  }),
                },
                "latest",
              ],
            },
          ]),
        });
        if (!response.ok)
          throw Object.assign(new Error("RPC request failed"), {
            status: response.status,
          });
        const replies: unknown = await response.json();
        requireValue(
          Array.isArray(replies) && replies.length === 2,
          503,
          "RPC_UNAVAILABLE",
          "Invalid RPC response.",
        );
        const result = (id: number): string => {
          const matches = (replies as Record<string, unknown>[]).filter(
            (r) => r && r.id === id,
          );
          const value = matches[0];
          if (value?.error) {
            const code = (value.error as { code?: unknown }).code;
            throw Object.assign(new Error("RPC method failed"), {
              code: typeof code === "number" ? code : undefined,
            });
          }
          requireValue(
            matches.length === 1 &&
              value?.jsonrpc === "2.0" &&
              typeof value.result === "string" &&
              /^0x[0-9a-f]+$/i.test(value.result),
            503,
            "RPC_UNAVAILABLE",
            "Invalid RPC response.",
          );
          return value!.result as string;
        };
        requireValue(
          BigInt(result(1)) === BigInt(rules.chainId),
          503,
          "RPC_UNAVAILABLE",
          "Wrong network.",
        );
        return decodeFunctionResult({
          abi: erc20Abi,
          functionName: "balanceOf",
          data: result(2) as `0x${string}`,
        });
      } catch (error) {
        const causes: {
          name: string;
          status?: number;
          code?: string | number;
        }[] = [];
        let cause: unknown = error;
        while (cause instanceof Error && causes.length < 5) {
          const detail = cause as Error & {
            status?: number;
            code?: string | number;
            cause?: unknown;
          };
          causes.push({
            name: detail.name,
            status: detail.status,
            code: detail.code,
          });
          cause = detail.cause;
        }
        // Omit RPC payloads, wallet addresses and balances from diagnostics.
        console.error(
          JSON.stringify({ event: "wallet.balance.failed", causes }),
        );
        throw new ApiError(
          503,
          "RPC_UNAVAILABLE",
          "The current MUSEGOD balance could not be checked. Your vote has not changed. Please retry.",
        );
      }
    },
  };
}

export async function membership(
  db: Database,
  a: Actor,
  services: WalletServices | undefined,
  rules: GovernanceRules = governanceRules,
): Promise<Membership> {
  requireValue(
    !a.agent,
    403,
    "SCOPE_DENIED",
    "Wallets and governance are human-only.",
  );
  requireValue(
    services,
    503,
    "WALLET_UNAVAILABLE",
    "Wallet verification is not available.",
  );
  const wallet = await services.findWallet(a.account.privy_user_id);
  let balance: bigint | null = null;
  if (wallet) {
    // The private mapping is evidence of this verification, never an auth cache.
    const conflict = await db.one(
      "SELECT 1 FROM musecity.qualification_wallets WHERE account_id<>$1 AND (privy_wallet_id=$2 OR address=$3)",
      [a.account.id, wallet.id, wallet.address],
    );
    requireValue(
      !conflict,
      409,
      "WALLET_CONFLICT",
      "This wallet is already associated with another account.",
    );
    balance = await services.balance(wallet.address, rules);
    requireValue(
      balance >= 0n,
      503,
      "RPC_UNAVAILABLE",
      "Invalid balance response.",
    );
    await db.query(
      `INSERT INTO musecity.qualification_wallets(account_id,privy_wallet_id,address,verified_at) VALUES($1,$2,$3,clock_timestamp())
      ON CONFLICT(account_id) DO UPDATE SET privy_wallet_id=EXCLUDED.privy_wallet_id,address=EXCLUDED.address,verified_at=EXCLUDED.verified_at`,
      [a.account.id, wallet.id, wallet.address],
    );
  } else
    await db.query(
      "DELETE FROM musecity.qualification_wallets WHERE account_id=$1",
      [a.account.id],
    );
  const formalMember = balance !== null && balance >= BigInt(rules.threshold);
  return {
    wallet,
    balance: balance?.toString() ?? null,
    formalMember,
    weight: formalMember ? rules.memberWeight : rules.ordinaryWeight,
    checkedAt: new Date().toISOString(),
    rules,
  };
}
