import { useState } from "react";
import { Inbox, Send, Archive, ShieldAlert, Trash2, Settings, LogOut, RefreshCw, Plus, Users, AlertTriangle } from "lucide-react";
import { useLocale } from "../i18n";
import type { Account } from "../types";

type TabName = "inbox" | "sent" | "archive" | "spam" | "trash" | "settings";

interface SidebarProps {
  activeTab: string;
  goToTab: (tab: TabName) => void;
  mobileMenuOpen: boolean;
  setMobileMenuOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  authStatus: string;
  isUserSyncing: boolean;
  unreadCount: number;
  onLogin: () => void;
  usesOverlaySidebar: boolean;
  // multi-account
  accounts: Account[];
  activeAccountId: string | null;
  onSwitchAccount: (id: string | null) => void;
  onAddAccount: () => void;
  onLogoutAccount: (accountId: string) => void;
  expiredAccountIds: Set<string>;
}

export function Sidebar({
  activeTab, goToTab, mobileMenuOpen, setMobileMenuOpen,
  authStatus, isUserSyncing, unreadCount, onLogin, usesOverlaySidebar,
  accounts, activeAccountId, onSwitchAccount, onAddAccount, onLogoutAccount,
  expiredAccountIds,
}: SidebarProps) {
  const tr = useLocale();
  const [hoveredAccount, setHoveredAccount] = useState<string | null>(null);

  const backdropCls = `fixed inset-x-0 bottom-0 top-9 z-40 bg-black/55 transition-opacity duration-200 ${
    usesOverlaySidebar && mobileMenuOpen ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"
  }`;
  const asideCls = usesOverlaySidebar
    ? `fixed left-0 top-9 bottom-0 z-50 flex w-56 flex-col border-r border-white/5 bg-[#0c0c0e]/95 shadow-2xl shadow-black/40 backdrop-blur-xl transition-transform duration-200 ease-out ${mobileMenuOpen ? "translate-x-0" : "-translate-x-full pointer-events-none"}`
    : "static z-auto flex w-56 flex-col border-r border-white/5 bg-[#0c0c0e] shadow-none";

  const navItem = (tab: TabName, icon: React.ReactNode, label: string, badge?: React.ReactNode) => (
    <button
      onClick={() => goToTab(tab)}
      className={`w-full flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-lg transition-all duration-200 ${
        activeTab === tab
          ? "bg-[var(--app-accent-soft)] text-zinc-100 shadow-[inset_2px_0_0_var(--app-accent)]"
          : "text-zinc-400 hover:bg-white/5 hover:text-zinc-200"
      }`}
    >
      {icon}
      {label}
      {badge}
    </button>
  );

  const accountItem = (accountId: string | null, picture: string | null, email: string, isAll = false) => {
    const isActive = accountId === null ? activeAccountId === null : activeAccountId === accountId;
    const isHovered = accountId !== null && hoveredAccount === accountId;
    const isExpired = accountId !== null && expiredAccountIds.has(accountId);

    const avatarRingCls = isExpired
      ? "ring-2 ring-orange-500 ring-offset-1 ring-offset-[#0c0c0e]"
      : isActive
      ? "ring-2 ring-[var(--app-accent)] ring-offset-1 ring-offset-[#0c0c0e]"
      : "";

    return (
      <div
        key={accountId ?? "__all__"}
        className="relative"
        onMouseEnter={() => accountId && setHoveredAccount(accountId)}
        onMouseLeave={() => setHoveredAccount(null)}
      >
        <button
          onClick={() => onSwitchAccount(accountId)}
          className={`w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg transition-all duration-200 ${
            isActive
              ? "bg-[var(--app-accent-soft)] shadow-[inset_2px_0_0_var(--app-accent)]"
              : "hover:bg-white/5"
          }`}
        >
          {/* Avatar with optional expired indicator */}
          <div className="relative shrink-0">
            {isAll ? (
              <div className={`w-7 h-7 rounded-full bg-zinc-800 border border-zinc-700 flex items-center justify-center ${isActive ? "ring-2 ring-[var(--app-accent)] ring-offset-1 ring-offset-[#0c0c0e]" : ""}`}>
                <Users className="w-3.5 h-3.5 text-zinc-400" />
              </div>
            ) : picture ? (
              <img
                src={picture}
                alt={email}
                className={`w-7 h-7 rounded-full object-cover ${avatarRingCls}`}
              />
            ) : (
              <div className={`w-7 h-7 rounded-full bg-zinc-700 flex items-center justify-center text-xs font-bold text-zinc-300 ${avatarRingCls}`}>
                {email[0]?.toUpperCase() ?? "?"}
              </div>
            )}
            {isExpired && (
              <span className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-orange-500 flex items-center justify-center">
                <AlertTriangle className="w-2 h-2 text-white" />
              </span>
            )}
          </div>

          <div className="flex-1 min-w-0">
            <div className={`text-xs font-medium truncate ${isExpired ? "text-orange-400" : isActive ? "text-zinc-100" : "text-zinc-300"}`}>
              {isAll ? tr.mail.allAccounts : email.split("@")[0]}
            </div>
            {!isAll && (
              <div className={`text-[10px] truncate ${isExpired ? "text-orange-600" : "text-zinc-600"}`}>
                {isExpired ? tr.mail.sessionExpired : email}
              </div>
            )}
          </div>
        </button>

        {/* Hover action button */}
        {!isAll && accountId && isHovered && (
          isExpired ? (
            <div className="absolute right-1.5 top-1/2 -translate-y-1/2 group/relogin">
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onLogin(); }}
                className="p-1 rounded hover:bg-white/10 text-orange-500 hover:text-orange-300 transition-all"
              >
                <RefreshCw className="w-3 h-3" />
              </button>
              <span className="pointer-events-none absolute right-0 top-full mt-1 z-[200] w-max rounded-md border border-white/10 bg-zinc-950 px-2 py-1 text-[10px] font-medium text-zinc-200 opacity-0 shadow-lg transition-opacity duration-150 delay-75 group-hover/relogin:opacity-100">
                Re-authenticate
              </span>
            </div>
          ) : (
            <div className="absolute right-1.5 top-1/2 -translate-y-1/2 group/logout">
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onLogoutAccount(accountId); }}
                className="p-1 rounded hover:bg-white/10 text-zinc-500 hover:text-red-400 transition-all"
              >
                <LogOut className="w-3 h-3" />
              </button>
              <span className="pointer-events-none absolute right-0 top-full mt-1 z-[200] w-max rounded-md border border-white/10 bg-zinc-950 px-2 py-1 text-[10px] font-medium text-zinc-200 opacity-0 shadow-lg transition-opacity duration-150 delay-75 group-hover/logout:opacity-100">
                Sign out
              </span>
            </div>
          )
        )}
      </div>
    );
  };

  return (
    <>
      <div className={backdropCls} onClick={() => setMobileMenuOpen(false)} aria-hidden={!mobileMenuOpen} />
      <aside className={asideCls}>
        {/* Navigation */}
        <nav className="flex-1 p-2 pt-3 space-y-0.5">
          {navItem(
            "inbox",
            <Inbox className="w-4 h-4" />,
            tr.nav.inbox,
            unreadCount > 0 ? (
              <span className="ml-auto text-[10px] bg-blue-500 text-white min-w-[18px] text-center py-0.5 px-1 rounded-full font-bold">
                {unreadCount}
              </span>
            ) : undefined
          )}
          {navItem("sent", <Send className="w-4 h-4" />, tr.nav.sent)}
          {navItem("archive", <Archive className="w-4 h-4" />, tr.nav.archive)}

          <div className="my-2 border-t border-white/5" />

          {navItem("spam", <ShieldAlert className="w-4 h-4" />, tr.nav.spam)}
          {navItem("trash", <Trash2 className="w-4 h-4" />, tr.nav.trash)}

          <div className="my-2 border-t border-white/5" />

          {navItem("settings", <Settings className="w-4 h-4" />, tr.nav.settings)}
        </nav>

        {/* Account section */}
        <div className="p-2 border-t border-white/5 space-y-0.5">
          {accounts.length === 0 ? (
            /* No accounts — show login prompt */
            <>
              {authStatus && (
                <div className="px-2 py-1 text-[10px] text-zinc-600">{authStatus}</div>
              )}
              <button
                onClick={onLogin}
                disabled={isUserSyncing}
                className="w-full flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-lg text-zinc-400 hover:bg-white/5 hover:text-zinc-200 transition-colors disabled:opacity-50"
              >
                <Settings className="w-4 h-4" />
                {tr.auth.loginWithGoogle}
                {isUserSyncing && <RefreshCw className="w-3.5 h-3.5 animate-spin text-blue-500 ml-auto" />}
              </button>
            </>
          ) : (
            <>
              {/* "All accounts" combined view — only when 2+ accounts */}
              {accounts.length > 1 && accountItem(null, null, tr.mail.allAccounts, true)}

              {/* Individual accounts */}
              {accounts.map(acc => accountItem(acc.id, acc.picture || null, acc.email))}

              {/* Add account */}
              <button
                onClick={onAddAccount}
                className="w-full flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg text-zinc-600 hover:text-zinc-300 hover:bg-white/5 transition-colors"
              >
                <div className="w-7 h-7 rounded-full border border-dashed border-zinc-700 flex items-center justify-center shrink-0">
                  <Plus className="w-3.5 h-3.5" />
                </div>
                <span className="text-xs">Add account</span>
              </button>
            </>
          )}
        </div>
      </aside>
    </>
  );
}
