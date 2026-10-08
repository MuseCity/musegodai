import {
  createContext,
  useContext,
  useEffect,
  useState,
  lazy,
  Suspense,
  type ReactNode,
} from "react";
import type { WalletSession } from "../shared/wallet";
export type Session = {
  ready: boolean;
  userId: string | null;
  login: () => void;
  logout: () => Promise<void>;
  token: () => Promise<string | null>;
  walletAddress?: string;
  wallet?: WalletSession;
  walletsReady?: boolean;
  retryWallet: () => Promise<void>;
  link: (kind: "email" | "google" | "twitter" | "wallet") => void;
  linked: string[];
  configured: boolean;
};
const anonymous: Session = {
  ready: false,
  userId: null,
  login: () => {},
  logout: async () => {},
  token: async () => null,
  retryWallet: async () => {},
  link: () => {},
  linked: [],
  configured: false,
};
export const AuthContext = createContext<Session>(anonymous);
export const useAuth = () => useContext(AuthContext);
const LiveAuth = lazy(() => import("./privy.client"));
export function AuthProvider({
  appId,
  children,
}: {
  appId: string;
  children: ReactNode;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!appId || !mounted)
    return (
      <AuthContext value={{ ...anonymous, ready: mounted }}>
        {children}
      </AuthContext>
    );
  return (
    <Suspense
      fallback={<AuthContext value={anonymous}>{children}</AuthContext>}
    >
      <LiveAuth appId={appId}>{children}</LiveAuth>
    </Suspense>
  );
}
export function RequireAuth({
  children,
  title = "Your place in musegod.ai.",
  description = "Sign in to meet neighbors, share what you are doing and bring your agents.",
}: {
  children: ReactNode;
  title?: string;
  description?: string;
}) {
  const auth = useAuth();
  if (!auth.ready)
    return (
      <div className="state" role="status">
        Loading your account…
      </div>
    );
  if (!auth.userId)
    return (
      <div className="state">
        <h1>{title}</h1>
        <p>{description}</p>
        <button
          className="primary"
          disabled={!auth.configured}
          onClick={auth.login}
        >
          {auth.configured ? "Sign in" : "Sign-in is not configured yet"}
        </button>
      </div>
    );
  return <div key={auth.userId}>{children}</div>;
}
