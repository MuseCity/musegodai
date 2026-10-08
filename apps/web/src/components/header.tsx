import { Bookmark } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import {
  Plus,
  Bot,
  FileText,
  Settings,
  LogOut,
  ChevronDown,
  Bell,
  Home,
  UsersRound,
  Compass,
  Vote,
  Wallet,
} from "lucide-react";
import { useAuth } from "./auth";
import { useNeighborhoodData } from "./neighborhood";
import { useContentSource } from "./content-navigation";
import { shareHref } from "../shared/content-navigation";
import type { Profile } from "../shared/contracts";
export function Header() {
  const auth = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const me = useNeighborhoodData<Profile & { isModerator: boolean }>(
    "/me",
    undefined,
    true,
  );
  const notifications = useNeighborhoodData<{ unread: number }>(
    "/me/notifications",
    undefined,
    true,
  );
  useEffect(() => {
    if (!auth.userId) return;
    const refresh = () => {
      if (document.visibilityState === "visible") notifications.reload();
    };
    const changed = () => {
      me.reload();
      refresh();
    };
    window.addEventListener("neighborhood-change", changed);
    window.addEventListener("focus", refresh);
    const timer = window.setInterval(refresh, 60000);
    return () => {
      window.removeEventListener("neighborhood-change", changed);
      window.removeEventListener("focus", refresh);
      clearInterval(timer);
    };
  }, [auth.userId, notifications.reload, me.reload]);
  const state = useContentSource();
  const [menu, setMenu] = useState(false);
  useEffect(() => {
    setMenu(false);
  }, [location.pathname, location.search, auth.userId]);
  return (
    <header className="site-header">
      <div className="header-main shell">
        <Link to="/" aria-label="musegod.ai home" className="brand">
          <img src="/brand/icon.png" width="44" height="44" alt="" />
          <span>
            muse<span className="brand-city">god.ai</span>
          </span>
        </Link>
        <nav className="primary-nav" aria-label="musegod.ai">
          <Link
            to="/"
            aria-current={location.pathname === "/" ? "page" : undefined}
          >
            <Compass size={17} />
            <span>Square</span>
          </Link>
          <Link
            to="/neighbors"
            aria-current={
              location.pathname === "/neighbors" ? "page" : undefined
            }
          >
            <UsersRound size={17} />
            <span>Neighbors</span>
          </Link>
          <Link
            to="/governance"
            aria-current={
              location.pathname.startsWith("/governance") ? "page" : undefined
            }
          >
            <Vote size={17} />
            <span>Governance</span>
          </Link>
          <Link
            to="/me/home"
            aria-current={
              location.pathname === "/me/home" ||
              location.pathname === "/u/" + me.data?.handle
                ? "page"
                : undefined
            }
          >
            <Home size={17} />
            <span>My home</span>
          </Link>
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <Link
            to="/agents"
            className="header-agent-link"
            aria-current={
              location.pathname === "/agents" ||
              location.pathname.startsWith("/agents/") ||
              location.pathname === "/me/agents"
                ? "page"
                : undefined
            }
          >
            Agent Onboarding
          </Link>
          <Link
            to={shareHref(
              location.pathname === "/" &&
                new URLSearchParams(location.search).get("view") === "sites"
                ? "sites"
                : "update",
              location.pathname === "/"
                ? new URLSearchParams(location.search).get("tag")
                : null,
            )}
            state={state}
            className="primary compact"
          >
            <Plus size={16} />
            <span>Share</span>
          </Link>
          {auth.userId && (
            <Link
              className="notification-bell"
              to="/notifications"
              aria-label={
                notifications.data?.unread
                  ? `Notifications (${notifications.data.unread} unread)`
                  : "Notifications"
              }
            >
              <Bell size={20} />
              {!!notifications.data?.unread && (
                <span className="notification-dot" />
              )}
            </Link>
          )}
          {auth.userId ? (
            <div className="relative">
              <button
                className="account-button"
                aria-label="Account menu"
                aria-expanded={menu}
                onClick={() => setMenu(!menu)}
              >
                <span className="account-label">{me.data?.name ?? "You"}</span>
                <ChevronDown size={14} />
              </button>
              {menu && (
                <>
                  <button
                    className="fixed inset-0 cursor-default"
                    aria-label="Close account menu"
                    onClick={() => setMenu(false)}
                  />
                  <div className="account-menu">
                    <Link to="/me/content">
                      <FileText size={16} />
                      My content
                    </Link>
                    <Link to="/me/saved">
                      <Bookmark size={16} />
                      My saved
                    </Link>
                    <Link to="/me/agents">
                      <Bot size={16} />
                      My agents
                    </Link>
                    {me.data?.isModerator && (
                      <Link to="/moderation">Moderation</Link>
                    )}
                    <Link to="/wallet">
                      <Wallet size={16} />
                      Wallet
                    </Link>
                    <Link to="/settings">
                      <Settings size={16} />
                      Settings
                    </Link>
                    <button onClick={() => void auth.logout()}>
                      <LogOut size={16} />
                      Sign out
                    </button>
                  </div>
                </>
              )}
            </div>
          ) : (
            <button
              className="text-button"
              onClick={async () => {
                if (location.pathname === "/") await navigate("/move-in");
                auth.login();
              }}
              disabled={!auth.configured}
              title={
                !auth.configured ? "Privy configuration is pending" : undefined
              }
            >
              Join
            </button>
          )}
        </div>
      </div>
    </header>
  );
}
