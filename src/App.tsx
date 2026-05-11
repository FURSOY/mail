import { useState, useEffect, useRef, useCallback, useTransition, type ReactNode, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Inbox, Send, Archive, Search, CornerUpLeft, Trash2, RefreshCw, LogOut, X, Minus, Square, Settings, ShieldAlert, Edit3, AlertTriangle, CheckCircle, XCircle, Copy, RotateCcw, DownloadCloud, Menu } from "lucide-react";
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import "./index.css";

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

function escapeHtml(text: string): string {
  return decodeBasicHtmlEntities(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sanitizeEmailHtml(html: string, fallback: string): string {
  const source = (html || "").trim();
  if (!source) {
    return `<div class="plain-text">${escapeHtml(fallback || "").replace(/\n/g, "<br/>")}</div>`;
  }

  const styles = (source.match(/<style\b[^>]*>[\s\S]*?<\/style>/gi) || []).join("\n");
  const cleaned = source
    .replace(/<!doctype[\s\S]*?>/gi, "")
    .replace(/<html\b[^>]*>/gi, "")
    .replace(/<\/html>/gi, "")
    .replace(/<head\b[\s\S]*?<\/head>/gi, "")
    .replace(/<meta\b[^>]*>/gi, "")
    .replace(/<base\b[^>]*>/gi, "")
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, "")
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s(href|src|action)\s*=\s*(["'])\s*javascript:[\s\S]*?\2/gi, "")
    .replace(/\s(href|src|action)\s*=\s*javascript:[^\s>]*/gi, "");

  const bodyMatch = cleaned.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  return `${styles}${bodyMatch ? bodyMatch[1] : cleaned}`;
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

const NEGATIVE_CONTEXT_RE = 
  /(?:po box|box|parkway|amphitheatre|tl|usd|eur|\$|€|tel|phone|fax|adres|address|street|sokak|cadde|mahalle|bulvar|kimlik|id|no\.|numarası)/i;

const STRONG_OTP_CONTEXT_RE =
  /(?:verification|verify|dogrulama|doğrulama|confirm|confirmation|onay|login|sign[\s-]?in|oturum|authentication|auth|two[\s-]?factor|2fa|mfa|one[\s-]?time|tek\s*kullanım|tek\s*kullanim)[\s\w.,:;'"()/-]{0,36}(?:code|kod|kodu|pin|otp|passcode|password|sifre|şifre)|(?:code|kod|kodu|pin|otp|passcode|verification code|security code|login code|confirmation code|one[\s-]?time password|one[\s-]?time code|2fa code|mfa code|sifre|şifre)/i;

const DIRECT_OTP_PREFIX_RE =
  /(?:code|kod|kodu|pin|otp|passcode|verification code|security code|login code|confirmation code|sifre|şifre)\s*(?:is|:|-|=|→)?\s*$/i;

const BROAD_NEGATIVE_CONTEXT_RE =
  /(?:iso(?:\/iec)?|certified|certificate|certification|standard|platform|developers?|community|experts?|subscribers?|followers?|members?|users?|customers?|blog|article|release|changelog|version|copyright|po box|box|parkway|amphitheatre|tl|try|usd|eur|\$|€|tel|phone|fax|adres|address|street|sokak|cadde|mahalle|bulvar|kimlik|id|no\.|numarası|numarasi|invoice|order|ticket|case|ref|reference)/i;

const METRIC_SUFFIX_RE = /^\d+(?:\.\d+)?[kmb]$/i;
const YEAR_OR_STANDARD_RE = /^(?:19|20)\d{2}$|^27001$|^27701$|^22301$|^9001$|^42001$/;

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
     if (m[1].length >= 4 && m[1].length <= 10 && !METRIC_SUFFIX_RE.test(m[1])) {
       candidates.push({ code: m[1], score: 0, index: m.index });
     }
  }

  if (candidates.length === 0) return null;

  for (const c of candidates) {
    if (METRIC_SUFFIX_RE.test(c.code) || YEAR_OR_STANDARD_RE.test(c.code)) {
      c.score = -999;
      continue;
    }

    const windowStart = Math.max(0, c.index - 140);
    const windowEnd = Math.min(text.length, c.index + c.code.length + 140);
    const contextStr = text.slice(windowStart, windowEnd);
    const before = text.slice(Math.max(0, c.index - 60), c.index);
    const after = text.slice(c.index + c.code.length, Math.min(text.length, c.index + c.code.length + 60));
    
    // Positive keywords
    if (STRONG_OTP_CONTEXT_RE.test(contextStr)) c.score += 80;
    
    // Direct prefixes like "kod: 123456"
    const directPrefix = new RegExp(`(?:code|kod|kodu|verification|doğrulama|otp|pin)[:\\s\\-]*${c.code}`, 'i');
    if (directPrefix.test(contextStr) || DIRECT_OTP_PREFIX_RE.test(before)) c.score += 140;
    if (/(?:expires?|valid|dakika|minute|min|within|use|enter|gir|kullan)/i.test(contextStr)) {
      c.score += 25;
    }

    // Negative keywords
    if (NEGATIVE_CONTEXT_RE.test(contextStr) || BROAD_NEGATIVE_CONTEXT_RE.test(contextStr)) c.score -= 120;
    if (/^[A-Z]{2,}\d+$/.test(c.code) && /(?:version|release|build|ticket|issue|case|ref)/i.test(contextStr)) c.score -= 120;
    if (/^[A-Z0-9]{4,10}$/.test(c.code) && /[A-Z]/.test(c.code) && !STRONG_OTP_CONTEXT_RE.test(contextStr)) c.score -= 80;
    if (/^\d+$/.test(c.code) && /[%+]/.test(before.slice(-2) + after.slice(0, 2))) c.score -= 100;
    if (/^\d+$/.test(c.code) && /(?:\bISO(?:\/IEC)?\s*$|\bISO(?:\/IEC)?\s+)/i.test(before.slice(-16) + after.slice(0, 16))) c.score -= 160;

    // Length heuristic: 6 is most common
    if (c.code.length === 6 && /^\d+$/.test(c.code)) c.score += 20;
    else if (/^\d+$/.test(c.code) && c.code.length === 8) c.score += 10;
    else if (/^\d+$/.test(c.code) && c.code.length === 4) c.score -= 15;

    // Position score: Earlier in the email is slightly better
    c.score -= (c.index / text.length) * 10;

    // Penalty for year-like numbers
    if (c.code.length === 4 && (c.code.startsWith("19") || c.code.startsWith("20"))) {
      c.score -= 40;
    }
  }

  const validCandidates = candidates.filter(c => c.score >= 70);
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
  const [activeTab, setActiveTab] = useState<'inbox' | 'sent' | 'archive' | 'spam' | 'trash' | 'settings'>('inbox');
  const [selectedMail, setSelectedMail] = useState<string | null>(null);
  const [authStatus, setAuthStatus] = useState<string>("Not authenticated");
  /** Kullanıcı yenile / giriş sonrası senkron — belirgin gösterge, buton kilidi */
  const [isUserSyncing, setIsUserSyncing] = useState(false);
  /** Arka plan polling — hafif; etkileşimi kilitlemez */
  const [isBackgroundSyncing, setIsBackgroundSyncing] = useState(false);
  
  // Settings
  const [syncIntervalValue, setSyncIntervalValue] = useState(() => {
    const saved = localStorage.getItem("fursoy_sync_interval");
    return saved ? parseInt(saved, 10) : 12;
  });
  const [notifDuration, setNotifDuration] = useState(() => {
    const saved = localStorage.getItem("fursoy_notif_duration");
    return saved ? parseInt(saved, 10) : 5;
  });
  const [notifInfinite, setNotifInfinite] = useState(() => {
    return localStorage.getItem("fursoy_notif_infinite") === "true";
  });
  const [pauseOnFullscreen, setPauseOnFullscreen] = useState(() => {
    return localStorage.getItem("fursoy_pause_on_fullscreen") === "true";
  });
  const [emails, setEmails] = useState<Email[]>([]);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [userInfo, setUserInfo] = useState<AuthInfo | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [showReply, setShowReply] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [showCompose, setShowCompose] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [composeTo, setComposeTo] = useState("");
  const [composeSubject, setComposeSubject] = useState("");
  const [composeBody, setComposeBody] = useState("");
  const [toasts, setToasts] = useState<{ id: number; msg: string; type: 'error' | 'success' | 'info' }[]>([]);
  const [verificationCopyState, setVerificationCopyState] = useState<"idle" | "copied">("idle");
  const [inboxUnread, setInboxUnread] = useState(0);
  const [tokenExpired, setTokenExpired] = useState(false);
  
  // Updater States
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState<{ version: string, date: string, body: string } | null>(null);
  const [updateProgress, setUpdateProgress] = useState<{ downloaded: number, total: number } | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  
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
  const recentlyReadRef = useRef<Set<string>>(new Set());
  const isFirstSyncRef = useRef(true);
  const tabEmailCacheRef = useRef<Partial<Record<string, Email[]>>>({});
  const [, startTabTransition] = useTransition();
  const [, startDataTransition] = useTransition();
  const activeTabRef = useRef(activeTab); // Track current tab for interval callbacks
  activeTabRef.current = activeTab; // Keep in sync
  const syncIntervalValueRef = useRef(syncIntervalValue);
  syncIntervalValueRef.current = syncIntervalValue;
  const notifDurationRef = useRef(notifDuration);
  notifDurationRef.current = notifDuration;
  const notifInfiniteRef = useRef(notifInfinite);
  notifInfiniteRef.current = notifInfinite;
  const pauseOnFullscreenRef = useRef(pauseOnFullscreen);
  pauseOnFullscreenRef.current = pauseOnFullscreen;

  useEffect(() => {
    accessTokenRef.current = accessToken;
  }, [accessToken]);

  // Toast helper
  const showToast = useCallback((msg: string, type: 'error' | 'success' | 'info' = 'info') => {
    const id = Date.now();
    setToasts(prev => [...prev.slice(-2), { id, msg, type }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
  }, []);

  const checkForUpdates = async (showUIMessages = false) => {
    try {
      if (showUIMessages) setIsCheckingUpdate(true);
      setUpdateError(null);
      const update = await check();
      
      if (update) {
        setUpdateAvailable({ version: update.version, date: update.date || '', body: update.body || '' });
        showToast(`Yeni bir güncelleme mevcut: v${update.version}`, "info");
      } else {
        setUpdateAvailable(null);
        if (showUIMessages) showToast("Mevcut sürüm güncel.", "success");
      }
    } catch (e) {
      console.error("Update check failed:", e);
      setUpdateError("Güncelleme kontrolü başarısız oldu.");
      if (showUIMessages) showToast("Güncelleme kontrolü başarısız.", "error");
    } finally {
      if (showUIMessages) setIsCheckingUpdate(false);
    }
  };

  const installUpdate = async () => {
    const update = await check();
    if (!update) return;

    try {
      setUpdateProgress({ downloaded: 0, total: 100 });
      let downloaded = 0;
      let totalLength = 0;
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case 'Started':
            totalLength = event.data.contentLength || 0;
            setUpdateProgress({ downloaded: 0, total: totalLength });
            break;
          case 'Progress':
            downloaded += event.data.chunkLength;
            setUpdateProgress({ downloaded, total: totalLength });
            break;
          case 'Finished':
            setUpdateProgress(null);
            break;
        }
      });
      await relaunch();
    } catch (e) {
      console.error("Update install failed", e);
      setUpdateError("Güncelleme yüklenirken bir hata oluştu.");
      setUpdateProgress(null);
    }
  };

  useEffect(() => {
    const openNotificationMail = async (emailId: string) => {
      if (!emailId) return;
      setMobileMenuOpen(false);
      startTabTransition(() => setActiveTab("inbox"));
      setSelectedMail(emailId);
      await loadEmails("inbox");
      await getCurrentWindow().show();
      await getCurrentWindow().unminimize();
      await getCurrentWindow().setFocus();
    };

    const unlistenCustomPromise = listen<{ emailId?: string }>('open-notification-mail', async (event) => {
      await openNotificationMail(event.payload?.emailId || "");
    });

    const unlistenPluginPromise = listen<{ actionId: string, notification: { title: string, body: string } }>('notification-action', async (event) => {
      const payload = event.payload?.notification;
      if (!payload) return;
      
      const key = (payload.title || "") + (payload.body || "");
      const emailId = recentNotificationsRef.current[key];
      await openNotificationMail(emailId || "");
    });

    return () => {
      unlistenCustomPromise.then(unlisten => unlisten());
      unlistenPluginPromise.then(unlisten => unlisten());
    };
  }, []);

  // Check update on startup
  useEffect(() => {
    void checkForUpdates(false);
  }, []);

  // Load emails by current tab from local DB
  const loadEmails = async (tab?: string) => {
    try {
      const label = tab || activeTabRef.current;
      const result = await invoke<Email[]>("get_emails_by_label", { label });
      
      // Override unread status if it was recently marked as read locally
      const adjusted = result.map(m => 
        recentlyReadRef.current.has(m.id) ? { ...m, unread: false } : m
      );
      
      tabEmailCacheRef.current[label] = adjusted;
      startDataTransition(() => setEmails(adjusted));
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
          code: code || null,
          emailId: email.id,
          duration: notifInfiniteRef.current ? 0 : notifDurationRef.current * 1000
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
    }, syncIntervalValueRef.current * 1000);
  };

  useEffect(() => {
    if (accessToken) {
      startPeriodicSync();
    }
  }, [syncIntervalValue]);

  // Background sync — fetch from Gmail and update local DB; uses syncWithAutoRefresh for all Gmail calls
  const backgroundSync = async (
    tokenOverride?: string | null,
    opts?: { userInitiated?: boolean }
  ): Promise<boolean> => {
    const token = tokenOverride ?? accessTokenRef.current;
    if (!token) return false;

    // Check for fullscreen if setting is enabled
    if (pauseOnFullscreenRef.current) {
      try {
        const isFullscreen = await invoke<boolean>("is_system_fullscreen");
        if (isFullscreen) {
          console.log("System in fullscreen/game mode, skipping background sync.");
          return false;
        }
      } catch (e) {
        console.error("Fullscreen check failed:", e);
      }
    }

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

    const handleIframeMessage = (e: MessageEvent) => {
      if (e.data && e.data.type === "open_url" && typeof e.data.url === "string") {
        openUrl(e.data.url).catch((err) => {
          console.error("Failed to open mail link:", err);
          showToast("Link tarayıcıda açılamadı.", "error");
        });
      }
    };
    window.addEventListener("message", handleIframeMessage);

    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("message", handleIframeMessage);
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
    setMobileMenuOpen(false);
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
      recentlyReadRef.current.add(mail.id);
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
  const activeMailHtml = activeMail ? sanitizeEmailHtml(activeMail.body_html, activeMail.snippet) : "";

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
          <button
            type="button"
            onClick={() => setMobileMenuOpen(true)}
            className="md:hidden -ml-1 mr-1 flex h-7 w-7 items-center justify-center rounded-md text-zinc-500 hover:bg-white/10 hover:text-zinc-200"
            style={{ WebkitAppRegion: 'no-drag' } as any}
            aria-label="Menüyü aç"
          >
            <Menu className="h-4 w-4" />
          </button>
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
        {mobileMenuOpen && (
          <div className="fixed inset-x-0 bottom-0 top-9 z-40 md:hidden">
            <button
              type="button"
              className="absolute inset-0 bg-black/55"
              onClick={() => setMobileMenuOpen(false)}
              aria-label="Menüyü kapat"
            />
          </div>
        )}

        {/* SIDEBAR */}
        <aside className={`${mobileMenuOpen ? 'fixed left-0 top-9 bottom-0 z-50 flex shadow-2xl shadow-black/40' : 'hidden'} md:static md:z-auto md:flex w-56 bg-[#0c0c0e] border-r border-white/5 flex-col`}>
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

          <div className="my-2 border-t border-white/5" />

          <button 
            onClick={() => goToTab("settings")}
            className={`w-full flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-lg transition-colors ${activeTab === 'settings' ? 'bg-white/10 text-zinc-100' : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200'}`}
          >
            <Settings className="w-4 h-4" /> Ayarlar
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

        {/* MAIN CONTENT AREA */}
        {activeTab === 'settings' ? (
          <section className="flex-1 overflow-y-auto bg-[#0a0a0c] p-8">
            <div className="max-w-2xl mx-auto">
              <h2 className="text-2xl font-bold text-zinc-100 mb-6 flex items-center gap-2">
                <Settings className="w-6 h-6" />
                Ayarlar
              </h2>

              <div className="space-y-8">
                {/* Sync Interval */}
                <div className="bg-white/[0.02] border border-white/5 rounded-xl p-5">
                  <h3 className="text-sm font-semibold text-zinc-200 mb-1">Senkronizasyon Sıklığı</h3>
                  <p className="text-xs text-zinc-500 mb-4">Arka planda maillerin kaç saniyede bir kontrol edileceğini belirleyin.</p>
                  
                  <div className="flex items-center gap-3">
                    <input 
                      type="number" 
                      min="5" 
                      max="300"
                      value={syncIntervalValue} 
                      onChange={(e) => {
                        let val = parseInt(e.target.value, 10) || 5;
                        setSyncIntervalValue(val);
                        localStorage.setItem("fursoy_sync_interval", val.toString());
                      }}
                      className="w-24 bg-[#09090b] border border-white/10 rounded-lg px-3 py-1.5 text-sm text-zinc-200 focus:border-blue-500/50 outline-none" 
                    />
                    <span className="text-sm text-zinc-400">saniye</span>
                  </div>
                </div>

                {/* Notification Duration */}
                <div className="bg-white/[0.02] border border-white/5 rounded-xl p-5">
                  <h3 className="text-sm font-semibold text-zinc-200 mb-1">Bildirim Ekranda Kalma Süresi</h3>
                  <p className="text-xs text-zinc-500 mb-4">Yeni mail bildirimi geldiğinde ekranda ne kadar süre kalacağını belirleyin.</p>
                  
                  <div className="space-y-4">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input 
                        type="checkbox" 
                        checked={notifInfinite}
                        onChange={(e) => {
                          const checked = e.target.checked;
                          setNotifInfinite(checked);
                          localStorage.setItem("fursoy_notif_infinite", checked.toString());
                        }}
                        className="w-4 h-4 rounded border-white/20 bg-[#09090b] text-blue-500 focus:ring-0 focus:ring-offset-0"
                      />
                      <span className="text-sm text-zinc-300">Hiç kapanmasın (Süresiz)</span>
                    </label>

                    <div className={`flex items-center gap-3 transition-opacity ${notifInfinite ? 'opacity-40 pointer-events-none' : ''}`}>
                      <input 
                        type="number" 
                        min="1" 
                        max="60"
                        value={notifDuration} 
                        onChange={(e) => {
                          let val = parseInt(e.target.value, 10) || 1;
                          setNotifDuration(val);
                          localStorage.setItem("fursoy_notif_duration", val.toString());
                        }}
                        disabled={notifInfinite}
                        className="w-24 bg-[#09090b] border border-white/10 rounded-lg px-3 py-1.5 text-sm text-zinc-200 focus:border-blue-500/50 outline-none disabled:bg-transparent" 
                      />
                      <span className="text-sm text-zinc-400">saniye</span>
                    </div>
                  </div>
                </div>

                {/* Performance Optimization */}
                <div className="bg-white/[0.02] border border-white/5 rounded-xl p-5">
                  <h3 className="text-sm font-semibold text-zinc-200 mb-1">Performans ve Oyun Modu</h3>
                  <p className="text-xs text-zinc-500 mb-4">Sistem kaynaklarını verimli kullanmak için ek ayarlar.</p>
                  
                  <div className="space-y-4">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input 
                        type="checkbox" 
                        checked={pauseOnFullscreen}
                        onChange={(e) => {
                          const checked = e.target.checked;
                          setPauseOnFullscreen(checked);
                          localStorage.setItem("fursoy_pause_on_fullscreen", checked.toString());
                        }}
                        className="w-4 h-4 rounded border-white/20 bg-[#09090b] text-blue-500 focus:ring-0 focus:ring-offset-0"
                      />
                      <span className="text-sm text-zinc-300">Oyun veya tam ekranda iken senkronizasyonu durdur</span>
                    </label>
                  </div>
                </div>

                {/* Updates */}
                <div className="bg-white/[0.02] border border-white/5 rounded-xl p-5">
                  <h3 className="text-sm font-semibold text-zinc-200 mb-1">Uygulama Güncellemeleri</h3>
                  <p className="text-xs text-zinc-500 mb-4">FURSOY Mail'in en son özelliklerini ve güvenlik yamalarını almak için uygulamayı güncel tutun.</p>
                  
                  <div className="space-y-4">
                    {!updateProgress ? (
                      <div className="flex items-center gap-3">
                        <button 
                          onClick={() => checkForUpdates(true)}
                          disabled={isCheckingUpdate}
                          className="px-4 py-2 bg-[#09090b] hover:bg-white/5 border border-white/10 rounded-lg text-sm text-zinc-200 font-medium transition-colors disabled:opacity-50 flex items-center gap-2"
                        >
                          {isCheckingUpdate ? <RefreshCw className="w-4 h-4 animate-spin" /> : <DownloadCloud className="w-4 h-4" />}
                          {isCheckingUpdate ? "Kontrol ediliyor..." : "Güncellemeleri Kontrol Et"}
                        </button>
                        {updateAvailable && (
                          <button 
                            onClick={installUpdate}
                            className="px-4 py-2 bg-blue-500 hover:bg-blue-600 rounded-lg text-sm text-white font-semibold transition-colors shadow-lg shadow-blue-500/20"
                          >
                            v{updateAvailable.version} Sürümüne Güncelle
                          </button>
                        )}
                      </div>
                    ) : (
                      <div className="bg-[#09090b] border border-white/10 rounded-lg p-4">
                        <div className="flex items-center justify-between text-xs text-zinc-300 mb-2">
                          <span className="font-medium text-blue-400">Güncelleme İndiriliyor...</span>
                          <span>
                            {updateProgress.total > 0 
                              ? Math.round((updateProgress.downloaded / updateProgress.total) * 100) 
                              : 0}%
                          </span>
                        </div>
                        <div className="h-1.5 w-full bg-white/5 rounded-full overflow-hidden">
                          <div 
                            className="h-full bg-blue-500 transition-all duration-300"
                            style={{ 
                              width: `${updateProgress.total > 0 ? (updateProgress.downloaded / updateProgress.total) * 100 : 0}%` 
                            }}
                          />
                        </div>
                        <p className="text-[10px] text-zinc-500 mt-2">
                          İndirme tamamlandığında uygulama otomatik olarak yeniden başlatılacaktır. Lütfen bekleyin.
                        </p>
                      </div>
                    )}
                    {updateError && (
                      <p className="text-xs text-red-400 font-medium">{updateError}</p>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </section>
        ) : (
          <>
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
                            html, body { min-height: 100%; margin: 0; }
                            html { background: #fff; }
                            body { margin: 0; padding: 16px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 14px; line-height: 1.6; color: #1a1a1a; overflow: auto; overflow-wrap: anywhere; }
                            img { max-width: 100% !important; height: auto !important; }
                            table { max-width: 100% !important; }
                            td, th { max-width: 100%; }
                            pre, code { white-space: pre-wrap; overflow-wrap: anywhere; }
                            .plain-text { white-space: pre-wrap; }
                            a { color: #2563eb; }
                            /* Custom scrollbar matching app theme */
                            ::-webkit-scrollbar { width: 5px; }
                            ::-webkit-scrollbar-track { background: transparent; }
                            ::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.12); border-radius: 10px; }
                            ::-webkit-scrollbar-thumb:hover { background: rgba(0,0,0,0.25); }
                          </style>
                        </head>
                        <body>
                          ${activeMailHtml}
                          <script>
                            function sendOpenUrl(url) {
                              if (!url || url.charAt(0) === "#") return false;
                              try {
                                window.parent.postMessage({ type: "open_url", url: new URL(url, document.baseURI).href }, "*");
                                return true;
                              } catch (_) {
                                return false;
                              }
                            }

                            document.addEventListener("click", function(e) {
                              var node = e.target && e.target.nodeType === 1 ? e.target : e.target && e.target.parentElement;
                              var target = node && node.closest ? node.closest("a[href], area[href]") : null;
                              if (!target) return;

                              var url = target.getAttribute("href") || target.href;
                              if (sendOpenUrl(url)) {
                                e.preventDefault();
                                e.stopPropagation();
                              }
                            }, true);

                            document.addEventListener("submit", function(e) {
                              var form = e.target;
                              if (!form || !form.getAttribute) return;

                              var url = form.getAttribute("action");
                              if (sendOpenUrl(url)) {
                                e.preventDefault();
                                e.stopPropagation();
                              }
                            }, true);
                          </script>
                        </body>
                      </html>
                    `}
                    sandbox="allow-popups allow-popups-to-escape-sandbox allow-scripts allow-same-origin"
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
          </>
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
