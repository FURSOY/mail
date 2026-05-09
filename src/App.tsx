import { useState, useEffect, useRef, useCallback, useTransition, type ReactNode, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Inbox, Send, Archive, Search, Command, CornerUpLeft, Trash2, RefreshCw, LogOut, X, Minus, Square, Settings, ShieldAlert, Edit3, AlertTriangle, CheckCircle, XCircle, Copy, RotateCcw } from "lucide-react";
import NotificationWindow from "./NotificationWindow";
import "./index.css";

/** Background polling when logged in (ms). Coalesced server-side if sync overlaps. */
const SYNC_INTERVAL_MS = 12_000;

function decodeBasicHtmlEntities(html: string): string {
  const codeToChar = (code: number) => {
    if (!Number.isFinite(code) || code < 1 || code > 0x10ffff) return " ";
    try {
      return String.fromCodePoint(code);
    } catch {
      return " ";
    }
  };
  return html
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;#(\d+);/gi, (_, n) => codeToChar(Number(n)))
    .replace(/&amp;#x([0-9a-f]+);/gi, (_, h) => codeToChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => codeToChar(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => codeToChar(parseInt(h, 16)))
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'");
}

function stripHtml(html: string): string {
  const decoded = decodeBasicHtmlEntities(html);
  return decoded
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Remove ZWSP etc.; collapse spaced digits from HTML chunks. */
function normalizeOtpPlaintext(text: string): string {
  let s = text.replace(/[\u200B-\u200D\uFEFF\u2060]/g, "");
  s = s.replace(/\s+/g, " ").trim();
  // Collapse "1 2 3 4 5 6"
  s = s.replace(/\b(?:\d[\s\u00A0]){3,11}\d\b/g, (m) => m.replace(/[\s\u00A0]+/g, ""));
  // Collapse "123 456" or "123-456" style
  s = s.replace(/\b(\d{3,4})[\s-](\d{3,4})\b/g, (m, g1, g2) => {
     if (g1.length + g2.length >= 4 && g1.length + g2.length <= 8) return g1 + g2;
     return m;
  });
  return s;
}

const OTP_CONTEXT_RE =
  /(?:code|kod|kodu|verification|doğrulama|onay|şifre|password|pin|otp|sign[\s-]?in|oturum|confirm|tek\s*kullanım|one[\s-]?time|güvenlik|security)/i;

const NEGATIVE_CONTEXT_RE = 
  /(?:po box|box|parkway|amphitheatre|tl|usd|eur|\$|€|tel|phone|fax|adres|address|street|sokak|cadde|mahalle|bulvar|kimlik|id|no\.|numarası)/i;

/** Detect OTP / verification codes using advanced context scoring. */
function extractVerificationCode(email: Email): string | null {
  const raw = `${email.subject} ${email.snippet} ${stripHtml(email.body_html)}`;
  const text = normalizeOtpPlaintext(raw);
  
  const candidates: { code: string; score: number; index: number }[] = [];

  // Find all 4-8 digit numbers
  const numRegex = /\b(\d{4,8})\b/g;
  let m;
  while ((m = numRegex.exec(text)) !== null) {
     candidates.push({ code: m[1], score: 0, index: m.index });
  }

  // Find alphanumeric candidates like A1B2C3 (uppercase, 4-10 chars, mixing letters and numbers)
  const alphaNumRegex = /\b([A-Z]+[0-9]+[A-Z0-9]*|[0-9]+[A-Z]+[A-Z0-9]*)\b/g;
  while ((m = alphaNumRegex.exec(text)) !== null) {
     if (m[1].length >= 4 && m[1].length <= 10) {
       candidates.push({ code: m[1], score: 0, index: m.index });
     }
  }

  if (candidates.length === 0) return null;

  for (const c of candidates) {
    const windowStart = Math.max(0, c.index - 100);
    const windowEnd = Math.min(text.length, c.index + c.code.length + 100);
    const contextStr = text.slice(windowStart, windowEnd);
    
    // Positive keywords
    if (OTP_CONTEXT_RE.test(contextStr)) c.score += 50;
    
    // Direct prefixes like "kod: 123456"
    const directPrefix = new RegExp(`(?:code|kod|kodu|verification|doğrulama|otp|pin)[:\\s\\-]*${c.code}`, 'i');
    if (directPrefix.test(contextStr)) c.score += 100;

    // Negative keywords
    if (NEGATIVE_CONTEXT_RE.test(contextStr)) c.score -= 80;

    // Length heuristic: 6 is most common
    if (c.code.length === 6 && /^\d+$/.test(c.code)) c.score += 20;
    else if (/^\d+$/.test(c.code) && (c.code.length === 4 || c.code.length === 8)) c.score += 10;

    // Position score: Earlier in the email is slightly better
    c.score -= (c.index / text.length) * 10;

    // Penalty for year-like numbers
    if (c.code.length === 4 && (c.code.startsWith("19") || c.code.startsWith("20"))) {
      c.score -= 40;
    }
  }

  const validCandidates = candidates.filter(c => c.score >= 40);
  if (validCandidates.length === 0) return null;

  validCandidates.sort((a, b) => b.score - a.score);
  return validCandidates[0].code;
}

/** Hover label (native `title` is unreliable in WebView2); keep short for layout. */
function ToolbarTip({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="group/tip relative inline-flex">
      {children}
      <span
        className="pointer-events-none absolute left-1/2 z-[200] mt-1.5 w-max max-w-[220px] -translate-x-1/2 top-full rounded-md border border-white/10 bg-zinc-950 px-2 py-1 text-center text-[10px] font-medium leading-tight text-zinc-200 opacity-0 shadow-lg transition-opacity duration-150 delay-75 group-hover/tip:opacity-100"
        role="tooltip"
      >
        {label}
      </span>
    </div>
  );
}

interface Email {
  id: string;
  sender: string;
  recipient: string;
  subject: string;
  snippet: string;
  body_html: string;
  date: number;
  unread: boolean;
  label: string;
}

interface AuthInfo {
  access_token: string;
  email: string;
  picture: string;
}

function App() {
  const [activeTab, setActiveTab] = useState<'inbox' | 'sent' | 'archive' | 'spam' | 'trash'>('inbox');
  const [selectedMail, setSelectedMail] = useState<string | null>(null);
  const [authStatus, setAuthStatus] = useState<string>("Not authenticated");
  /** Kullanıcı yenile / giriş sonrası senkron — belirgin gösterge, buton kilidi */
  const [isUserSyncing, setIsUserSyncing] = useState(false);
  /** Arka plan polling — hafif; etkileşimi kilitlemez */
  const [isBackgroundSyncing, setIsBackgroundSyncing] = useState(false);
  const [emails, setEmails] = useState<Email[]>([]);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [userInfo, setUserInfo] = useState<AuthInfo | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [showReply, setShowReply] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [showCompose, setShowCompose] = useState(false);
  const [composeTo, setComposeTo] = useState("");
  const [composeSubject, setComposeSubject] = useState("");
  const [composeBody, setComposeBody] = useState("");
  const [toasts, setToasts] = useState<{ id: number; msg: string; type: 'error' | 'success' | 'info' }[]>([]);
  const [verificationCopyState, setVerificationCopyState] = useState<"idle" | "copied">("idle");
  const [inboxUnread, setInboxUnread] = useState(0);
  const [tokenExpired, setTokenExpired] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const syncIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recentNotificationsRef = useRef<Record<string, string>>({});
  /** Latest access token for interval/manual sync (avoids stale closure + matches React state). */
  const accessTokenRef = useRef<string | null>(null);
  const backgroundSyncRef = useRef<
    (tokenOverride?: string | null, opts?: { userInitiated?: boolean }) => Promise<boolean>
  >(async () => false);
  const knownEmailIdsRef = useRef<Set<string>>(new Set());
  const isFirstSyncRef = useRef(true);
  const tabEmailCacheRef = useRef<Partial<Record<string, Email[]>>>({});
  const [, startTabTransition] = useTransition();
  const [, startDataTransition] = useTransition();
  const activeTabRef = useRef(activeTab); // Track current tab for interval callbacks
  activeTabRef.current = activeTab; // Keep in sync

  useEffect(() => {
    accessTokenRef.current = accessToken;
  }, [accessToken]);

  // Toast helper
  const showToast = useCallback((msg: string, type: 'error' | 'success' | 'info' = 'info') => {
    const id = Date.now();
    setToasts(prev => [...prev.slice(-2), { id, msg, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
  }, []);

  useEffect(() => {
    const unlistenPromise = listen<{ actionId: string, notification: { title: string, body: string } }>('notification-action', async (event) => {
      const payload = event.payload?.notification;
      if (!payload) return;
      
      const key = (payload.title || "") + (payload.body || "");
      const emailId = recentNotificationsRef.current[key];
      
      if (emailId) {
        setSelectedMail(emailId);
        await getCurrentWindow().unminimize();
        await getCurrentWindow().setFocus();
      }
    });

    return () => {
      unlistenPromise.then(unlisten => unlisten());
    };
  }, []);

  // Load emails by current tab from local DB
  const loadEmails = async (tab?: string) => {
    try {
      const label = tab || activeTabRef.current;
      const result = await invoke<Email[]>("get_emails_by_label", { label });
      tabEmailCacheRef.current[label] = result;
      startDataTransition(() => setEmails(result));
    } catch (e) {
      console.error("Failed to load emails:", e);
    }
  };

  // Auto-refresh token and retry on 401
  const syncWithAutoRefresh = useCallback(async (token: string): Promise<string> => {
    try {
      await invoke("sync_emails", { accessToken: token });
      return token;
    } catch (e: unknown) {
      const errStr = String(e);
      if (errStr.includes("401") || errStr.includes("Unauthorized") || errStr.includes("invalid_grant")) {
        try {
          const refreshed = await invoke<AuthInfo>("refresh_access_token");
          accessTokenRef.current = refreshed.access_token;
          setUserInfo(refreshed);
          setAccessToken(refreshed.access_token);
          setTokenExpired(false);
          await invoke("sync_emails", { accessToken: refreshed.access_token });
          return refreshed.access_token;
        } catch {
          setTokenExpired(true);
          showToast("Oturum süresi doldu. Tekrar giriş yapın.", "error");
          throw e;
        }
      }
      throw e;
    }
  }, [showToast]);

  // Fetch inbox unread count (always from DB, regardless of active tab)
  const refreshUnreadCount = async () => {
    try {
      const count = await invoke<number>("get_inbox_unread_count");
      startDataTransition(() => setInboxUnread(count));
      return count;
    } catch { return 0; }
  };

  const notifyNewEmails = useCallback(async (newEmails: Email[]) => {
    if (newEmails.length === 0) return;

    try {
      for (const email of newEmails.slice(0, 5)) {
        const senderName = email.sender.split("<")[0].replace(/"/g, "").trim() || email.sender;
        const code = extractVerificationCode(email);
        
        let notifTitle = senderName.slice(0, 64);
        let notifBody = (email.subject || email.snippet || "").trim().slice(0, 100) || "Yeni ileti";

        // Let the Rust backend spawn the notification window
        // It will automatically suppress it if the user is in a fullscreen game!
        await invoke("show_custom_notification", {
          title: notifTitle,
          body: notifBody,
          code: code || null
        });
      }
    } catch (e) {
      console.error("Notification error:", e);
    }
  }, []);

  /** Stop background polling (logout / unmount). */
  const clearPeriodicSync = () => {
    if (syncIntervalRef.current !== null) {
      clearInterval(syncIntervalRef.current);
      syncIntervalRef.current = null;
    }
  };

  /** Start or restart polling; tick always uses latest token via ref. */
  const startPeriodicSync = () => {
    clearPeriodicSync();
    syncIntervalRef.current = setInterval(() => {
      void backgroundSyncRef.current();
    }, SYNC_INTERVAL_MS);
  };

  // Background sync — fetch from Gmail and update local DB; uses syncWithAutoRefresh for all Gmail calls
  const backgroundSync = async (
    tokenOverride?: string | null,
    opts?: { userInitiated?: boolean }
  ): Promise<boolean> => {
    const token = tokenOverride ?? accessTokenRef.current;
    if (!token) return false;
    const userInitiated = opts?.userInitiated ?? false;
    try {
      if (userInitiated) setIsUserSyncing(true);
      else setIsBackgroundSyncing(true);
      const newToken = await syncWithAutoRefresh(token);
      accessTokenRef.current = newToken;

      const freshInbox = await invoke<Email[]>("get_emails_by_label", { label: "inbox" });

      const newUnreadEmails = freshInbox.filter(
        e => e.unread && !knownEmailIdsRef.current.has(e.id)
      );

      knownEmailIdsRef.current = new Set(freshInbox.map(e => e.id));

      if (isFirstSyncRef.current) {
        isFirstSyncRef.current = false;
      } else {
        notifyNewEmails(newUnreadEmails);
      }

      await loadEmails();
      await refreshUnreadCount();
      return true;
    } catch (e) {
      console.error("Background sync failed:", e);
      const msg = e instanceof Error ? e.message : String(e);
      showToast(`Senkronizasyon başarısız: ${msg}`, "error");
      return false;
    } finally {
      if (userInitiated) setIsUserSyncing(false);
      else setIsBackgroundSyncing(false);
    }
  };

  backgroundSyncRef.current = backgroundSync;

  useEffect(() => {
    refreshUnreadCount();

    invoke<AuthInfo | null>("get_auth_info")
      .then(async (info) => {
        if (!info) return;

        setUserInfo(info);
        setAccessToken(info.access_token);
        accessTokenRef.current = info.access_token;

        let activeToken = info.access_token;
        try {
          const refreshed = await invoke<AuthInfo>("refresh_access_token");
          setUserInfo(refreshed);
          setAccessToken(refreshed.access_token);
          accessTokenRef.current = refreshed.access_token;
          activeToken = refreshed.access_token;
        } catch {
          console.log("Token refresh skipped, using existing token");
        }

        await backgroundSyncRef.current(activeToken);
        startPeriodicSync();
      })
      .catch(console.error);

    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
      if (e.key === "Escape") {
        setShowReply(false);
        searchInputRef.current?.blur();
      }
    };
    window.addEventListener("keydown", handleKeyDown);

    const unlistenFocus = listen("focus-main-window", async () => {
      const win = getCurrentWindow();
      await win.unminimize();
      await win.show();
      await win.setFocus();
    });

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      clearPeriodicSync();
      unlistenFocus.then(f => f());
    };
  }, []);

  useEffect(() => {
    const cached = tabEmailCacheRef.current[activeTab];
    if (cached !== undefined) {
      setEmails(cached);
    }
    void loadEmails(activeTab);
  }, [activeTab]);

  const goToTab = (tab: typeof activeTab) => {
    setSelectedMail(null);
    setShowReply(false);
    startTabTransition(() => setActiveTab(tab));
  };

  async function loginWithGoogle() {
    try {
      setAuthStatus("Waiting for browser...");
      const res = await invoke<AuthInfo>("start_google_oauth");
      setUserInfo(res);
      setAccessToken(res.access_token);
      accessTokenRef.current = res.access_token;
      setAuthStatus("Logged in! Syncing...");
      setTokenExpired(false);

      const ok = await backgroundSyncRef.current(res.access_token, { userInitiated: true });
      if (ok) {
        setAuthStatus("Sync complete!");
        showToast("Giriş başarılı!", "success");
      } else {
        setAuthStatus("Sync failed after login. Will retry automatically.");
      }
      startPeriodicSync();
    } catch (e) {
      setAuthStatus("Error: " + e);
      setIsUserSyncing(false);
      showToast("Giriş başarısız: " + e, "error");
    }
  }

  async function handleLogout() {
    try {
      clearPeriodicSync();
      await invoke("logout");
      setUserInfo(null);
      setAccessToken(null);
      accessTokenRef.current = null;
      setEmails([]);
      setAuthStatus("Logged out.");
    } catch (e) {
      console.error("Logout failed:", e);
    }
  }

  const handleRefresh = async () => {
    const token = accessTokenRef.current ?? accessToken;
    if (!token) {
      setAuthStatus("Lütfen yenilemek için önce giriş yapın.");
      showToast("Önce giriş yapın.", "error");
      return;
    }
    setAuthStatus("Senkronize ediliyor...");
    const ok = await backgroundSyncRef.current(token, { userInitiated: true });
    if (ok) {
      setAuthStatus("Güncel.");
      showToast("Mailler güncellendi", "success");
    } else {
      setAuthStatus("Senkronizasyon başarısız. Ağ veya oturumu kontrol edin.");
    }
  };

  const handleMailClick = async (mail: Email) => {
    setSelectedMail(mail.id);
    setShowReply(false);
    setReplyText("");
    if (mail.unread) {
      setEmails(prev => prev.map(m => m.id === mail.id ? { ...m, unread: false } : m));
      try {
        await invoke("mark_as_read", { 
          accessToken: accessToken || "", 
          messageId: mail.id 
        });
      } catch (e) {
        console.error("Failed to mark as read:", e);
      }
    }
  };

  const handleArchive = async (emailId: string) => {
    if (!accessToken) return;
    setEmails(prev => prev.map(e => e.id === emailId ? { ...e, label: 'archive' } : e));
    setSelectedMail(null);
    try {
      await invoke("archive_email", { accessToken, messageId: emailId });
      await loadEmails(activeTabRef.current);
      await refreshUnreadCount();
    } catch (e) {
      showToast("Arşivleme başarısız", "error");
      loadEmails(activeTabRef.current);
    }
  };

  const handleTrash = async (emailId: string) => {
    if (!accessToken) return;
    setEmails(prev => prev.map(e => e.id === emailId ? { ...e, label: "trash" } : e));
    setSelectedMail(null);
    try {
      await invoke("trash_email", { accessToken, messageId: emailId });
      await loadEmails(activeTabRef.current);
      await refreshUnreadCount();
    } catch (e) {
      showToast("Silme başarısız", "error");
      loadEmails(activeTabRef.current);
    }
  };

  const handleMoveToInbox = async (emailId: string) => {
    if (!accessToken) return;
    setEmails(prev => prev.filter(e => e.id !== emailId));
    setSelectedMail(null);
    try {
      await invoke("move_to_inbox", { accessToken, messageId: emailId });
      showToast("Gelen kutusuna taşındı", "success");
      void loadEmails(activeTabRef.current);
      void refreshUnreadCount();
    } catch (e) {
      showToast("Taşıma başarısız", "error");
      loadEmails(activeTabRef.current);
    }
  };

  const handlePermanentDelete = async (emailId: string) => {
    if (!accessToken) return;
    if (!window.confirm("Bu e-posta kalıcı olarak silinsin mi? Bu işlem geri alınamaz.")) return;
    setEmails(prev => prev.filter(e => e.id !== emailId));
    setSelectedMail(null);
    try {
      await invoke("permanently_delete", { accessToken, messageId: emailId });
      showToast("Kalıcı olarak silindi", "success");
    } catch (e) {
      showToast("Silme başarısız", "error");
      loadEmails(activeTabRef.current);
    }
  };

  const handleReply = async () => {
    if (!accessToken || !activeMail || !replyText.trim()) return;
    setIsSending(true);
    try {
      // Extract email address from "Name <email>" format
      const senderMatch = activeMail.sender.match(/<([^>]+)>/);
      const to = senderMatch ? senderMatch[1] : activeMail.sender;

      await invoke("send_reply", {
        accessToken,
        to,
        subject: activeMail.subject,
        body: replyText.replace(/\n/g, "<br/>"),
        threadId: activeMail.id,
        messageId: activeMail.id,
      });
      setReplyText("");
      setShowReply(false);
    } catch (e) {
      showToast("Yanıt gönderilemedi", "error");
    }
    setIsSending(false);
  };

  const handleComposeSend = async () => {
    if (!accessToken || !composeTo.trim() || !composeSubject.trim()) return;
    setIsSending(true);
    try {
      await invoke("send_email", {
        accessToken,
        to: composeTo,
        subject: composeSubject,
        body: composeBody.replace(/\n/g, "<br/>"),
      });
      setShowCompose(false);
      setComposeTo("");
      setComposeSubject("");
      setComposeBody("");
    } catch (e) {
      showToast("Gönderim başarısız", "error");
    }
    setIsSending(false);
  };

  const activeMail = emails.find(m => m.id === selectedMail);

  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp);
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();
    if (isToday) {
      return date.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
    }
    return date.toLocaleDateString('tr-TR', { month: 'short', day: 'numeric' });
  };

  const formatDateFull = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleDateString('tr-TR', { month: 'long', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  const displayEmails = emails.filter(email => {
    if (!searchQuery) return true;
    return email.subject.toLowerCase().includes(searchQuery.toLowerCase()) || 
      email.sender.toLowerCase().includes(searchQuery.toLowerCase()) ||
      email.snippet.toLowerCase().includes(searchQuery.toLowerCase());
  });

  const unreadCount = inboxUnread;

  const verificationCode = activeMail ? extractVerificationCode(activeMail) : null;

  useEffect(() => {
    setVerificationCopyState("idle");
  }, [selectedMail, verificationCode]);

  const showArchiveBtn = activeTab === "inbox" || activeTab === "sent";
  const showRestoreBtn = activeTab === "trash" || activeTab === "spam" || activeTab === "archive";
  const showTrashToBinBtn = activeTab !== "trash";
  const showDeleteForeverBtn = activeTab === "trash";

  return (
    <div className="flex flex-col h-screen bg-[#09090b] text-zinc-300 font-sans overflow-hidden select-none">
      
      {/* CUSTOM TITLEBAR */}
      <div data-tauri-drag-region className="h-9 shrink-0 flex items-center justify-between pl-2 pr-0 border-b border-white/5 bg-[#09090b]" style={{ WebkitAppRegion: 'drag' } as any}>
        <div data-tauri-drag-region className="flex items-center gap-2 text-xs font-medium text-zinc-500 pl-1">
          <img src="/logo.svg" className="w-4 h-4 object-contain" alt="MailApp Logo" />
          <span className="text-zinc-400">FURSOY Mail</span>
        </div>
        <div className="flex items-center" style={{ WebkitAppRegion: 'no-drag' } as any}>
          <button 
            onClick={() => getCurrentWindow().minimize()}
            className="w-11 h-9 flex items-center justify-center text-zinc-500 hover:bg-white/10 hover:text-zinc-200 transition-colors"
          >
            <Minus className="w-4 h-4" />
          </button>
          <button 
            onClick={() => getCurrentWindow().toggleMaximize()}
            className="w-11 h-9 flex items-center justify-center text-zinc-500 hover:bg-white/10 hover:text-zinc-200 transition-colors"
          >
            <Square className="w-3 h-3" />
          </button>
          <button 
            onClick={async () => {
              const window = getCurrentWindow();
              await window.hide();
            }}
            className="w-11 h-9 flex items-center justify-center text-zinc-500 hover:bg-red-500/80 hover:text-white transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* SIDEBAR */}
        <aside className="hidden md:flex w-56 bg-[#0c0c0e] border-r border-white/5 flex-col">
          <nav className="flex-1 p-2 pt-3 space-y-0.5">
            <button 
              onClick={() => goToTab("inbox")}
              className={`w-full flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-lg transition-colors ${activeTab === 'inbox' ? 'bg-white/10 text-zinc-100' : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200'}`}
            >
              <Inbox className="w-4 h-4" /> Inbox
              {unreadCount > 0 && (
                <span className="ml-auto text-[10px] bg-blue-500 text-white min-w-[18px] text-center py-0.5 px-1 rounded-full font-bold">{unreadCount}</span>
              )}
            </button>
            <button 
              onClick={() => goToTab("sent")}
              className={`w-full flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-lg transition-colors ${activeTab === 'sent' ? 'bg-white/10 text-zinc-100' : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200'}`}
            >
              <Send className="w-4 h-4" /> Sent
            </button>
            <button 
              onClick={() => goToTab("archive")}
              className={`w-full flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-lg transition-colors ${activeTab === 'archive' ? 'bg-white/10 text-zinc-100' : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200'}`}
            >
              <Archive className="w-4 h-4" /> Archive
          </button>

          <div className="my-2 border-t border-white/5" />

          <button 
            onClick={() => goToTab("spam")}
            className={`w-full flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-lg transition-colors ${activeTab === 'spam' ? 'bg-white/10 text-zinc-100' : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200'}`}
          >
            <ShieldAlert className="w-4 h-4" /> Spam
          </button>
          <button 
            onClick={() => goToTab("trash")}
            className={`w-full flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-lg transition-colors ${activeTab === 'trash' ? 'bg-white/10 text-zinc-100' : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200'}`}
          >
            <Trash2 className="w-4 h-4" /> Trash
          </button>
          </nav>

          <div className="p-2 mt-auto">
            {userInfo ? (
              <div className="flex items-center gap-2.5 px-2.5 py-2 rounded-lg bg-white/[0.03] border border-white/5 relative group">
                <img src={userInfo.picture} alt="Profile" className="w-7 h-7 rounded-full bg-zinc-800 object-cover shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="text-xs font-medium text-zinc-300 truncate">{userInfo.email.split('@')[0]}</div>
                  <div className="text-[10px] text-zinc-600 truncate">{userInfo.email}</div>
                </div>

                <ToolbarTip label="Çıkış">
                  <button
                    type="button"
                    onClick={handleLogout}
                    className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-white/10 text-zinc-500 hover:text-red-400 transition-all"
                  >
                    <LogOut className="w-3.5 h-3.5" />
                  </button>
                </ToolbarTip>
              </div>
            ) : (
              <>
                <div className="px-2 py-1 text-[10px] text-zinc-600">{authStatus}</div>
                <button onClick={loginWithGoogle} disabled={isUserSyncing} className="w-full flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-lg text-zinc-400 hover:bg-white/5 hover:text-zinc-200 transition-colors disabled:opacity-50">
                  <Settings className="w-4 h-4" /> Login with Google
                  {isUserSyncing && <RefreshCw className="w-3.5 h-3.5 animate-spin text-blue-500 ml-auto" />}
                </button>
              </>
            )}
          </div>
        </aside>

        {/* Compose FAB */}
        {userInfo && (
          <div className="fixed bottom-6 right-6 z-50">
            <ToolbarTip label="Yeni e-posta">
              <button
                type="button"
                onClick={() => setShowCompose(true)}
                className="w-12 h-12 rounded-full bg-blue-500 hover:bg-blue-600 text-white flex items-center justify-center shadow-lg shadow-blue-500/25 transition-all hover:scale-105 active:scale-95"
              >
                <Edit3 className="w-5 h-5" />
              </button>
            </ToolbarTip>
          </div>
        )}

        {/* Compose Modal */}
        {showCompose && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
            <div className="w-full max-w-lg bg-[#111113] border border-white/10 rounded-xl shadow-2xl flex flex-col overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
                <h3 className="text-sm font-semibold text-zinc-200">New Email</h3>
                <button onClick={() => setShowCompose(false)} className="p-1 rounded hover:bg-white/10 text-zinc-400"><X className="w-4 h-4" /></button>
              </div>
              <div className="p-4 space-y-3 flex-1">
                <input value={composeTo} onChange={e => setComposeTo(e.target.value)} placeholder="To" className="w-full bg-white/[0.03] border border-white/5 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-blue-500/40 select-text" />
                <input value={composeSubject} onChange={e => setComposeSubject(e.target.value)} placeholder="Subject" className="w-full bg-white/[0.03] border border-white/5 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-blue-500/40 select-text" />
                <textarea value={composeBody} onChange={e => setComposeBody(e.target.value)} placeholder="Write your message..." className="w-full bg-white/[0.03] border border-white/5 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-blue-500/40 resize-none min-h-[200px] select-text" />
              </div>
              <div className="flex items-center justify-between px-4 py-3 border-t border-white/5">
                <button onClick={() => setShowCompose(false)} className="text-xs text-zinc-500 hover:text-zinc-300">Discard</button>
                <button onClick={handleComposeSend} disabled={!composeTo.trim() || !composeSubject.trim() || isSending} className="px-5 py-1.5 bg-blue-500 hover:bg-blue-600 disabled:opacity-40 text-white text-xs font-medium rounded-lg transition-colors flex items-center gap-2">
                  {isSending ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                  {isSending ? "Sending..." : "Send"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* MAIL LIST */}
        <section className={`flex flex-col border-r border-white/5 bg-[#09090b] ${selectedMail ? 'hidden md:flex md:w-80 lg:w-96' : 'flex-1 md:w-80 lg:w-96 md:flex-none'}`}>
          <div className="h-12 flex items-center px-4 border-b border-white/5 justify-between shrink-0">
            <div className="flex items-center gap-2.5">
              <h2 className="font-semibold text-zinc-100 text-sm capitalize">{activeTab}</h2>
              {isUserSyncing && (
                <span className="text-[10px] uppercase tracking-wider text-blue-500 font-semibold animate-pulse">Senkronize…</span>
              )}
              {isBackgroundSyncing && !isUserSyncing && (
                <span className="text-[10px] text-zinc-600 font-medium">Arka planda güncelleniyor</span>
              )}
            </div>
            <div className="flex items-center gap-1">
              <ToolbarTip label="Gelen kutusunu sunucudan yenile">
                <button
                  type="button"
                  onClick={handleRefresh}
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
                placeholder="Search emails... (Ctrl+K)" 
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

          {/* List */}
          <div className="flex-1 overflow-y-auto">
            {displayEmails.length === 0 && !isUserSyncing && !isBackgroundSyncing && (
              <div className="p-8 text-center text-zinc-600 text-xs">
                {searchQuery ? "No emails match your search." : activeTab === 'inbox' ? "Inbox is empty." : `No ${activeTab} emails.`}
              </div>
            )}
            {displayEmails.map((mail) => (
              <div 
                key={mail.id} 
                onClick={() => handleMailClick(mail)}
                className={`px-4 py-3 border-b border-white/[0.03] cursor-pointer transition-all relative ${
                  selectedMail === mail.id 
                    ? 'bg-blue-500/10 border-l-2 border-l-blue-500' 
                    : 'hover:bg-white/[0.02] border-l-2 border-l-transparent'
                }`}
              >
                {mail.unread && <div className="absolute left-1 top-4 w-1.5 h-1.5 rounded-full bg-blue-500"></div>}
                <div className="flex justify-between items-baseline mb-0.5 gap-2">
                  <span className={`text-xs truncate ${mail.unread ? 'font-semibold text-zinc-100' : 'text-zinc-400'}`}>
                    {mail.label === 'sent' 
                      ? `To: ${(mail.recipient || '').split('<')[0].replace(/"/g, '').trim() || mail.recipient}`
                      : mail.sender.split('<')[0].replace(/"/g, '').trim()
                    }
                  </span>
                  <span className="text-[10px] text-zinc-600 shrink-0">{formatDate(mail.date)}</span>
                </div>
                <h3 className={`text-xs truncate ${mail.unread ? 'text-zinc-200 font-medium' : 'text-zinc-500'}`}>{mail.subject}</h3>
                <p className="text-[11px] text-zinc-600 mt-0.5 truncate">{mail.snippet}</p>
              </div>
            ))}
          </div>
        </section>

        {/* MAIL DETAIL */}
        {activeMail ? (
          <main className="flex-1 flex flex-col bg-[#0a0a0c] relative z-10">
            {/* Mobile Back Button */}
            <div className="md:hidden h-12 flex items-center px-4 border-b border-white/5 shrink-0">
              <button onClick={() => { setSelectedMail(null); setShowReply(false); }} className="flex items-center gap-2 text-xs text-zinc-400 hover:text-zinc-200">
                <CornerUpLeft className="w-3.5 h-3.5" /> Back
              </button>
            </div>

            {/* Desktop Toolbar */}
            <div className="hidden md:flex h-12 items-center justify-between px-5 border-b border-white/5 shrink-0">
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-zinc-500 flex items-center gap-1.5 capitalize">
                  {activeTab === 'inbox' && <Inbox className="w-3.5 h-3.5" />}
                  {activeTab === 'sent' && <Send className="w-3.5 h-3.5" />}
                  {activeTab === 'archive' && <Archive className="w-3.5 h-3.5" />}
                  {activeTab === 'spam' && <ShieldAlert className="w-3.5 h-3.5" />}
                  {activeTab === 'trash' && <Trash2 className="w-3.5 h-3.5" />}
                  {activeTab}
                </span>
              </div>
              <div className="flex items-center gap-0.5" style={{ WebkitAppRegion: "no-drag" } as CSSProperties}>
                <ToolbarTip label="Yanıtla">
                  <button
                    type="button"
                    onClick={() => { setShowReply(!showReply); setTimeout(() => replyRef.current?.focus(), 100); }}
                    className={`p-2 rounded-md hover:bg-white/5 transition-colors ${showReply ? 'text-blue-400 bg-blue-500/10' : 'text-zinc-400 hover:text-zinc-200'}`}
                  >
                    <CornerUpLeft className="w-4 h-4" />
                  </button>
                </ToolbarTip>
                {showRestoreBtn && (
                  <ToolbarTip label={activeTab === "spam" ? "Spam değil (gelen kutusu)" : "Gelen kutusuna taşı"}>
                    <button
                      type="button"
                      onClick={() => handleMoveToInbox(activeMail.id)}
                      className="p-2 rounded-md hover:bg-white/5 text-zinc-400 hover:text-emerald-400 transition-colors"
                    >
                      <RotateCcw className="w-4 h-4" />
                    </button>
                  </ToolbarTip>
                )}
                {showArchiveBtn && (
                  <ToolbarTip label="Arşivle">
                    <button
                      type="button"
                      onClick={() => handleArchive(activeMail.id)}
                      className="p-2 rounded-md hover:bg-white/5 text-zinc-400 hover:text-amber-400 transition-colors"
                    >
                      <Archive className="w-4 h-4" />
                    </button>
                  </ToolbarTip>
                )}
                {showTrashToBinBtn && (
                  <ToolbarTip label="Çöpe taşı">
                    <button
                      type="button"
                      onClick={() => handleTrash(activeMail.id)}
                      className="p-2 rounded-md hover:bg-white/5 text-zinc-400 hover:text-red-400 transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </ToolbarTip>
                )}
                {showDeleteForeverBtn && (
                  <ToolbarTip label="Kalıcı olarak sil">
                    <button
                      type="button"
                      onClick={() => handlePermanentDelete(activeMail.id)}
                      className="p-2 rounded-md hover:bg-white/5 text-zinc-400 hover:text-red-500 transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </ToolbarTip>
                )}
              </div>
            </div>
            
            <div className="flex-1 overflow-y-auto p-6 md:p-8 flex flex-col" style={{ minHeight: 0 }}>
              <div className="max-w-3xl mx-auto w-full flex-1 flex flex-col" style={{ minHeight: 0 }}>
                <h1 className="text-xl font-bold text-zinc-100 mb-5 shrink-0">{activeMail.subject}</h1>
                
                {/* Verification Code Banner */}
                {verificationCode && (
                  <div className="mb-4 flex items-center justify-between px-4 py-3 rounded-lg bg-blue-500/10 border border-blue-500/20 shrink-0">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-lg bg-blue-500/20 flex items-center justify-center">
                        <ShieldAlert className="w-4 h-4 text-blue-400" />
                      </div>
                      <div>
                        <div className="text-[11px] text-blue-400/70 font-medium">Doğrulama Kodu</div>
                        <div className="text-lg font-bold text-blue-300 tracking-[0.3em] font-mono">{verificationCode}</div>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        void navigator.clipboard.writeText(verificationCode);
                        setVerificationCopyState("copied");
                        window.setTimeout(() => setVerificationCopyState("idle"), 2000);
                      }}
                      className="min-w-[7.5rem] justify-center px-4 py-2 rounded-lg bg-blue-500 hover:bg-blue-400 text-white text-xs font-semibold transition-colors flex items-center gap-2"
                    >
                      <Copy className="w-3.5 h-3.5" />
                      {verificationCopyState === "copied" ? "Kopyalandı" : "Kopyala"}
                    </button>
                  </div>
                )}

                <div className="flex items-center justify-between mb-5 pb-5 border-b border-white/5 shrink-0">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-full bg-gradient-to-tr from-blue-500 to-purple-500 flex items-center justify-center text-white text-sm font-bold shrink-0">
                      {activeMail.sender.charAt(0).toUpperCase() || "U"}
                    </div>
                    <div>
                      <div className="text-sm font-medium text-zinc-200">{activeMail.sender.split('<')[0].replace(/"/g, '').trim()}</div>
                      <div className="text-[11px] text-zinc-600 mt-0.5">
                        {activeTab === 'sent' ? 'from me' : 'to me'} · {formatDateFull(activeMail.date)}
                      </div>
                    </div>
                  </div>
                  {/* Mobile action buttons */}
                  <div className="flex md:hidden items-center gap-1">
                    <ToolbarTip label="Yanıtla">
                      <button type="button" onClick={() => { setShowReply(!showReply); }} className="p-2 rounded-md hover:bg-white/5 text-zinc-400">
                        <CornerUpLeft className="w-4 h-4" />
                      </button>
                    </ToolbarTip>
                    {showRestoreBtn && (
                      <ToolbarTip label={activeTab === "spam" ? "Spam değil" : "Gelen kutusu"}>
                        <button type="button" onClick={() => handleMoveToInbox(activeMail.id)} className="p-2 rounded-md hover:bg-white/5 text-zinc-400">
                          <RotateCcw className="w-4 h-4" />
                        </button>
                      </ToolbarTip>
                    )}
                    {showArchiveBtn && (
                      <ToolbarTip label="Arşivle">
                        <button type="button" onClick={() => handleArchive(activeMail.id)} className="p-2 rounded-md hover:bg-white/5 text-zinc-400">
                          <Archive className="w-4 h-4" />
                        </button>
                      </ToolbarTip>
                    )}
                    {showTrashToBinBtn && (
                      <ToolbarTip label="Çöpe taşı">
                        <button type="button" onClick={() => handleTrash(activeMail.id)} className="p-2 rounded-md hover:bg-white/5 text-zinc-400">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </ToolbarTip>
                    )}
                    {showDeleteForeverBtn && (
                      <ToolbarTip label="Kalıcı sil">
                        <button type="button" onClick={() => handlePermanentDelete(activeMail.id)} className="p-2 rounded-md hover:bg-white/5 text-zinc-400">
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </ToolbarTip>
                    )}
                  </div>
                </div>

                <div className="flex-1 flex flex-col bg-white rounded-lg overflow-hidden" style={{ minHeight: 0 }}>
                  <iframe
                    srcDoc={`
                      <!DOCTYPE html>
                      <html>
                        <head>
                          <base target="_blank" href="https://mail.google.com/">
                          <style>
                            * { box-sizing: border-box; }
                            html, body { height: 100%; margin: 0; }
                            body { margin: 0; padding: 16px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #1a1a1a; overflow-y: auto; }
                            img { max-width: 100% !important; height: auto !important; }
                            a { color: #2563eb; }
                            /* Custom scrollbar matching app theme */
                            ::-webkit-scrollbar { width: 5px; }
                            ::-webkit-scrollbar-track { background: transparent; }
                            ::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.12); border-radius: 10px; }
                            ::-webkit-scrollbar-thumb:hover { background: rgba(0,0,0,0.25); }
                          </style>
                        </head>
                        <body>
                          ${activeMail.body_html || activeMail.snippet}
                        </body>
                      </html>
                    `}
                    sandbox="allow-popups allow-popups-to-escape-sandbox"
                    className="w-full border-none flex-1"
                  />
                </div>

                {/* Reply Box */}
                {showReply && (
                  <div className="mt-4 rounded-lg border border-white/10 bg-white/[0.02] overflow-hidden">
                    <div className="px-4 py-2.5 border-b border-white/5 flex items-center gap-2">
                      <CornerUpLeft className="w-3.5 h-3.5 text-zinc-500" />
                      <span className="text-xs text-zinc-400">
                        Reply to <span className="text-zinc-300">{activeMail.sender.split('<')[0].replace(/"/g, '').trim()}</span>
                      </span>
                    </div>
                    <textarea
                      ref={replyRef}
                      value={replyText}
                      onChange={(e) => setReplyText(e.target.value)}
                      placeholder="Write your reply..."
                      className="w-full bg-transparent p-4 text-sm text-zinc-200 placeholder:text-zinc-600 outline-none resize-none min-h-[120px] select-text"
                    />
                    <div className="px-4 py-2.5 border-t border-white/5 flex items-center justify-between">
                      <button 
                        onClick={() => { setShowReply(false); setReplyText(""); }}
                        className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={handleReply}
                        disabled={!replyText.trim() || isSending}
                        className="px-4 py-1.5 bg-blue-500 hover:bg-blue-600 disabled:opacity-40 disabled:hover:bg-blue-500 text-white text-xs font-medium rounded-md transition-colors flex items-center gap-2"
                      >
                        {isSending ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                        {isSending ? "Sending..." : "Send Reply"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </main>
        ) : (
          <main className="hidden md:flex flex-1 items-center justify-center bg-[#0a0a0c]">
            <div className="text-center">
              <div className="w-14 h-14 rounded-2xl bg-white/[0.03] flex items-center justify-center mx-auto mb-3">
                <Inbox className="w-7 h-7 text-zinc-700" />
              </div>
              <h3 className="text-zinc-500 font-medium text-sm">No message selected</h3>
              <p className="text-xs text-zinc-700 mt-1">Select an email to read it here.</p>
            </div>
          </main>
        )}
      </div>

      {/* Token expired banner */}
      {tokenExpired && (
        <div className="absolute top-9 left-0 right-0 bg-red-500/90 backdrop-blur-sm px-4 py-2 flex items-center justify-between z-50">
          <div className="flex items-center gap-2 text-white text-xs font-medium">
            <AlertTriangle className="w-3.5 h-3.5" />
            Oturum süresi doldu. Tekrar giriş yapın.
          </div>
          <button 
            onClick={loginWithGoogle}
            className="px-3 py-1 bg-white text-red-600 text-xs font-semibold rounded hover:bg-red-50 transition-colors"
          >
            Giriş Yap
          </button>
        </div>
      )}

      {/* Toast notifications */}
      <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none max-w-sm">
        {toasts.map(toast => (
          <div 
            key={toast.id}
            className={`pointer-events-auto flex items-center gap-2 px-4 py-2.5 rounded-lg shadow-lg text-xs font-medium backdrop-blur-md animate-[slideIn_0.3s_ease] ${
              toast.type === 'error' ? 'bg-red-500/90 text-white' :
              toast.type === 'success' ? 'bg-emerald-500/90 text-white' :
              'bg-zinc-800/90 text-zinc-200 border border-white/10'
            }`}
          >
            {toast.type === 'error' && <XCircle className="w-3.5 h-3.5 shrink-0" />}
            {toast.type === 'success' && <CheckCircle className="w-3.5 h-3.5 shrink-0" />}
            <span className="flex-1 min-w-0 break-words">{toast.msg}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default App;
