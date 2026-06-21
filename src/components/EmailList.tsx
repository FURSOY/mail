import { Search, X, RefreshCw, Settings, Columns2, PanelLeft, Rows3, Menu } from "lucide-react";
import { useLocale } from "../i18n";
import type { Account, EmailSummary, ThreadGroup, MailViewPreference } from "../types";
import { formatDate } from "../utils";
import { ToolbarTip } from "./ToolbarTip";

interface EmailListProps {
  className: string;
  threadGroups: ThreadGroup[];
  selectedMail: string | null;
  onMailClick: (mail: EmailSummary) => void;
  isUserSyncing: boolean;
  isBackgroundSyncing: boolean;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  activeTab: string;
  usesOverlaySidebar: boolean;
  onMenuOpen: () => void;
  mailViewPreference: MailViewPreference;
  onViewPreferenceChange: (mode: MailViewPreference) => void;
  onRefresh: () => void;
  accessToken: string | null;
  accounts?: Account[];
  activeAccountId?: string | null;
}

export function EmailList({
  className, threadGroups, selectedMail, onMailClick,
  isUserSyncing, isBackgroundSyncing,
  searchQuery, setSearchQuery, searchInputRef,
  activeTab, usesOverlaySidebar, onMenuOpen,
  mailViewPreference, onViewPreferenceChange,
  onRefresh, accessToken,
  accounts, activeAccountId,
}: EmailListProps) {
  const tr = useLocale();
  const showAccountBadge = activeAccountId === null && (accounts?.length ?? 0) > 1;

  return (
    <section className={className}>
      <div className="h-12 flex items-center px-4 border-b border-white/5 justify-between shrink-0">
        <div className="flex min-w-0 items-center gap-2.5">
          {usesOverlaySidebar && (
            <button
              type="button"
              onClick={onMenuOpen}
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-500 hover:bg-white/10 hover:text-zinc-200"
            >
              <Menu className="h-4 w-4" />
            </button>
          )}
          <h2 className="min-w-0 truncate font-semibold text-zinc-100 text-sm capitalize" title={activeTab}>
            {activeTab}
          </h2>
          {isUserSyncing && (
            <span className="text-[10px] uppercase tracking-wider text-blue-500 font-semibold animate-pulse">
              Syncing…
            </span>
          )}
          {isBackgroundSyncing && !isUserSyncing && (
            <span className="text-[10px] text-zinc-600 font-medium">{tr.mail.updatingInBackground}</span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <div className="inline-flex rounded-md border border-white/10 bg-white/[0.03] p-0.5">
            {(
              [
                ["auto", Settings, tr.mail.viewAuto],
                ["split", Columns2, tr.mail.viewSideBySide],
                ["single-toggle", PanelLeft, tr.mail.viewCompact],
                ["inbox-first", Rows3, tr.mail.viewListFocus],
              ] as const
            ).map(([mode, Icon, label]) => (
              <button
                key={mode}
                type="button"
                title={label}
                aria-label={label}
                onClick={() => onViewPreferenceChange(mode)}
                className={`flex h-7 w-7 items-center justify-center rounded text-zinc-500 transition-colors ${
                  mailViewPreference === mode
                    ? "bg-white/10 text-zinc-100"
                    : "hover:bg-white/5 hover:text-zinc-300"
                }`}
              >
                <Icon className="h-3.5 w-3.5" />
              </button>
            ))}
          </div>
          <ToolbarTip label={tr.mail.forceRefresh}>
            <button
              type="button"
              onClick={onRefresh}
              disabled={isUserSyncing || !accessToken}
              className="p-1.5 rounded-md hover:bg-white/10 text-zinc-500 transition-all disabled:opacity-20"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isUserSyncing ? "animate-spin text-blue-500" : ""}`} />
            </button>
          </ToolbarTip>
        </div>
      </div>

      {/* Search Bar */}
      <div className="p-2 border-b border-white/5">
        <div className="relative group">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-zinc-600 group-focus-within:text-blue-500 transition-colors" />
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={tr.mail.searchPlaceholder}
            className="w-full bg-white/[0.03] border border-white/5 rounded-lg pl-8 pr-7 py-1.5 text-xs outline-none focus:border-blue-500/40 focus:bg-white/[0.02] transition-colors text-zinc-200 placeholder:text-zinc-600 select-text"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 text-zinc-500 hover:text-zinc-300 rounded hover:bg-white/10 transition-colors"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>

      {/* Thread List */}
      <div className="flex-1 overflow-y-auto">
        {threadGroups.length === 0 && !isUserSyncing && !isBackgroundSyncing && (
          <div className="p-8 text-center text-zinc-600 text-xs">
            {searchQuery
              ? tr.mail.searchEmpty
              : activeTab === "inbox"
              ? tr.mail.emptyInbox
              : tr.mail.emptyFolder}
          </div>
        )}
        {threadGroups.map((group) => {
          const mail = group.latestEmail;
          const isSelected = selectedMail === mail.id;
          const senderDisplay = activeTab === "sent"
            ? `To: ${(mail.recipient || "").split("<")[0].replace(/"/g, "").trim() || mail.recipient}`
            : group.participants.slice(0, 3).join(", ");
          const snippetPrefix = group.count > 1
            ? `${mail.sender.split("<")[0].replace(/"/g, "").trim()}: `
            : "";

          return (
            <div
              key={mail.thread_id || mail.id}
              onClick={() => onMailClick(mail)}
              className={`px-4 py-[var(--mail-row-py)] border-b border-white/[0.03] cursor-pointer transition-all duration-200 relative ${
                isSelected
                  ? "bg-[var(--app-accent-soft)] border-l-2 border-l-[var(--app-accent)]"
                  : "hover:bg-white/[0.02] border-l-2 border-l-transparent"
              }`}
            >
              {/* Unread dot */}
              {group.hasUnread && (
                <div className="absolute left-1 top-4 w-1.5 h-1.5 rounded-full bg-blue-500" />
              )}

              {/* Row 1: participants + count + date */}
              <div className="flex justify-between items-baseline mb-0.5 gap-2 min-w-0">
                <span
                  className={`min-w-0 truncate text-xs ${group.hasUnread ? "font-semibold text-zinc-100" : "text-zinc-400"}`}
                  title={senderDisplay}
                >
                  {senderDisplay}
                </span>
                <div className="flex items-center gap-1.5 shrink-0">
                  {group.count > 1 && (
                    <span className="text-[10px] text-zinc-600 tabular-nums">
                      {group.count}
                    </span>
                  )}
                  <span className="text-[10px] text-zinc-600">{formatDate(mail.date)}</span>
                </div>
              </div>

              {/* Row 2: subject */}
              <h3
                className={`min-w-0 truncate text-xs ${group.hasUnread ? "text-zinc-200 font-medium" : "text-zinc-500"}`}
                title={mail.subject}
              >
                {mail.subject}
              </h3>

              {/* Row 3: snippet */}
              <p className="mt-0.5 min-w-0 truncate text-[11px] text-zinc-600" title={mail.snippet}>
                {snippetPrefix}{mail.snippet}
              </p>

              {/* Account badge (multi-account "all" view) */}
              {showAccountBadge && (() => {
                const acc = accounts?.find(a => a.id === mail.account_id);
                if (!acc) return null;
                return (
                  <div className="mt-1 flex items-center gap-1">
                    {acc.picture ? (
                      <img src={acc.picture} className="w-3.5 h-3.5 rounded-full shrink-0" alt="" />
                    ) : (
                      <div className="w-3.5 h-3.5 rounded-full bg-zinc-700 flex items-center justify-center text-[8px] font-bold text-zinc-400 shrink-0">
                        {acc.email[0]?.toUpperCase()}
                      </div>
                    )}
                    <span className="text-[10px] text-zinc-600 truncate">{acc.email}</span>
                  </div>
                );
              })()}
            </div>
          );
        })}
      </div>
    </section>
  );
}
