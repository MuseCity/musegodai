// Browser fixture entry only. Production root uses components/auth.tsx directly.
import {
  useEffect,
  useState,
  useMemo,
  useRef,
  useCallback,
  type ReactNode,
} from "react";
import { AuthContext } from "../src/components/auth";
import { Dialog } from "../src/components/ui";
import type { Transfer } from "../src/shared/wallet";
import { fixtureWallet, defaultScenario, type WalletScenario } from "./wallet";
import { stringToHex } from "viem";
export function AuthProvider({
  children,
}: {
  children: ReactNode;
  appId: string;
}) {
  const [user, setUser] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [scenario, setScenario] = useState<WalletScenario>(defaultScenario);
  const scenarioRef = useRef(defaultScenario);
  const [approval, setApproval] = useState<Transfer | null>(null);
  const [museSignature, setMuseSignature] = useState<{
    address: string;
    message: string;
  } | null>(null);
  const pendingSignature = useRef<{
    resolve: (signature: string) => void;
    reject: (error: Error) => void;
  } | null>(null);
  const pending = useRef<{
    resolve: () => void;
    reject: (error: Error) => void;
  } | null>(null);
  const requestApproval = useCallback(
    (transfer: Transfer) =>
      new Promise<void>((resolve, reject) => {
        pending.current = { resolve, reject };
        setApproval(transfer);
      }),
    [],
  );
  const wallet = useMemo(
    () =>
      user
        ? fixtureWallet(user, () => scenarioRef.current, requestApproval)
        : undefined,
    [user, requestApproval],
  );
  useEffect(() => {
    setUser(sessionStorage.getItem("musecity.fixture-user"));
    setReady(true);
  }, []);
  useEffect(() => {
    if (!scenario.membershipError) return;
    const original = window.fetch;
    window.fetch = async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof Request
            ? input.url
            : input.href;
      if (
        new URL(url, window.location.href).pathname === "/api/v1/me/membership"
      )
        return Response.json(
          {
            error: {
              code: "RPC_UNAVAILABLE",
              message: "Local simulated membership check unavailable.",
            },
          },
          { status: 503 },
        );
      return original(input, init);
    };
    return () => {
      window.fetch = original;
    };
  }, [scenario.membershipError]);
  function update(patch: Partial<WalletScenario>) {
    scenarioRef.current = { ...scenarioRef.current, ...patch };
    setScenario(scenarioRef.current);
  }
  function finish(accepted: boolean) {
    setApproval(null);
    const request = pending.current;
    pending.current = null;
    if (accepted) request?.resolve();
    else request?.reject(new Error("User rejected request"));
  }
  function change(value: string | null) {
    pendingSignature.current?.reject(
      new Error("Your account changed. Please try again."),
    );
    pendingSignature.current = null;
    setMuseSignature(null);
    setUser(value);
    if (value) sessionStorage.setItem("musecity.fixture-user", value);
    else sessionStorage.removeItem("musecity.fixture-user");
  }
  return (
    <AuthContext
      value={{
        ready,
        userId: user,
        login: () => change("alice"),
        logout: async () => change(null),
        token: async () => (user ? "fixture:" + user : null),
        wallet: scenario.connection === "ready" ? wallet : undefined,
        walletAddress:
          scenario.connection === "missing" ? undefined : wallet?.address,
        evmAddresses: wallet ? [wallet.address] : [],
        signMessage: async (address, message) => {
          if (
            scenario.connection !== "ready" ||
            address.toLowerCase() !== wallet?.address.toLowerCase()
          )
            throw new Error("Connect the wallet that holds this muse.");
          return new Promise<string>((resolve, reject) => {
            pendingSignature.current = { resolve, reject };
            setMuseSignature({ address, message });
          });
        },
        walletsReady: ready && scenario.connection !== "preparing",
        retryWallet: async () => {
          update({ connection: "ready" });
        },
        link: () => {},
        linked: ["twitter_oauth"],
        configured: ready,
      }}
    >
      <div
        className="bg-amber-50 text-amber-900 text-center text-[10px] p-1"
        data-testid="fixture-banner"
      >
        LOCAL TEST · simulated identity and wallet · real local PostgreSQL{" "}
        <button
          className="underline ml-3"
          onClick={() => change(user === "bob" ? "alice" : "bob")}
        >
          Switch test account
        </button>
      </div>
      <details
        className="text-xs bg-amber-50 px-4"
        data-testid="wallet-fixture-controls"
      >
        <summary className="cursor-pointer py-1">
          Local wallet test scenarios
        </summary>
        <div className="grid gap-2 py-3">
          <label>
            Balance scenario
            <select
              aria-label="Balance scenario"
              value={scenario.balance}
              onChange={(e) =>
                update({ balance: e.target.value as WalletScenario["balance"] })
              }
            >
              <option value="normal">Normal balances</option>
              <option value="zero">Zero balances</option>
              <option value="default-error">Default balance error</option>
            </select>
          </label>
          <label>
            Receipt scenario
            <select
              aria-label="Receipt scenario"
              value={scenario.receipt}
              onChange={(e) =>
                update({ receipt: e.target.value as WalletScenario["receipt"] })
              }
            >
              <option value="confirmed">Confirmed</option>
              <option value="pending">Pending</option>
              <option value="reverted">Reverted</option>
              <option value="error">Status lookup error</option>
            </select>
          </label>
          <label>
            Connection scenario
            <select
              aria-label="Connection scenario"
              value={scenario.connection}
              onChange={(e) =>
                update({
                  connection: e.target.value as WalletScenario["connection"],
                })
              }
            >
              <option value="ready">Ready</option>
              <option value="preparing">Preparing</option>
              <option value="missing">Not created</option>
              <option value="unavailable">Connection unavailable</option>
            </select>
          </label>
          <button
            className="text-link"
            onClick={() => update({ uncertain: !scenario.uncertain })}
          >
            Uncertain submission: {scenario.uncertain ? "on" : "off"}
          </button>
          <button
            className="text-link"
            onClick={() => update({ networkError: !scenario.networkError })}
          >
            Network switch failure: {scenario.networkError ? "on" : "off"}
          </button>
          <button
            className="text-link"
            onClick={() =>
              update({ membershipError: !scenario.membershipError })
            }
          >
            Membership failure: {scenario.membershipError ? "on" : "off"}
          </button>
        </div>
      </details>
      {children}
      {museSignature && (
        <Dialog
          title="Local muse signature"
          onClose={() => {
            pendingSignature.current?.reject(
              new Error("User rejected request"),
            );
            pendingSignature.current = null;
            setMuseSignature(null);
          }}
        >
          <p>SIMULATION ONLY · No real wallet signature.</p>
          <p className="wallet-wrap">{museSignature.message}</p>
          <button
            className="primary"
            data-testid="approve-muse-signature"
            onClick={() => {
              pendingSignature.current?.resolve(
                stringToHex(
                  `local-muse-signature:${museSignature.address.toLowerCase()}:${museSignature.message}`,
                ),
              );
              pendingSignature.current = null;
              setMuseSignature(null);
            }}
          >
            Approve simulated signature
          </button>
        </Dialog>
      )}
      {approval && (
        <Dialog title="Local wallet confirmation" onClose={() => finish(false)}>
          <p>SIMULATION ONLY · No real funds or signatures.</p>
          <p className="wallet-wrap">
            {approval.amount} {approval.asset.symbol} to {approval.recipient}
          </p>
          <div className="wallet-dialog-actions">
            <button className="secondary" onClick={() => finish(false)}>
              Cancel simulated transfer
            </button>
            <button className="primary" onClick={() => finish(true)}>
              Approve simulated transfer
            </button>
          </div>
        </Dialog>
      )}
    </AuthContext>
  );
}
