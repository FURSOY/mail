import { useState, useEffect, useRef, useCallback, useTransition, type ReactNode, type CSSProperties } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Inbox, Send, Archive, Search, CornerUpLeft, Trash2, RefreshCw, LogOut, X, Minus, Plus, Square, Settings, ShieldAlert, Edit3, AlertTriangle, CheckCircle, XCircle, Copy, RotateCcw, DownloadCloud, Menu, Columns2, PanelLeft, Rows3, Maximize2, Forward, Users, Eye } from "lucide-react";
import { check } from '@tauri-apps/plugin-updater';
import { relaunch } from '@tauri-apps/plugin-process';
import { tr } from "./i18n";
import { themePresets, typography, ui, type ThemePresetName } from "./theme";
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

const LARGE_BODY_RENDER_LIMIT = 4_000_000;
/** Inline data: URIs (embedded images) larger than this are dropped to avoid pathological payloads. */
const MAX_INLINE_DATA_URI = 4_000_000;
/** Emails whose content refuses to shrink below this width are treated as fixed-layout cards
 *  (rendered at their own width on the dark surface) rather than stretched to fill the panel. */
const FIXED_LAYOUT_MIN_WIDTH = 460;
/** In "fit" mode, narrow fixed-layout emails are scaled up to fill the panel, but no more than
 *  this factor so a tiny email isn't blown up absurdly. */

/** Remote email images are fetched through the Rust backend (custom protocol) so that servers
 *  sending restrictive Cross-Origin-Resource-Policy headers don't get blocked (ERR_BLOCKED_BY_RESPONSE).
 *  On Windows, Tauri serves registered custom schemes at http://<scheme>.localhost. */
const IMAGE_PROXY_BASE = "http://mailimg.localhost/?url=";

/** Route http(s) <img> sources through the backend proxy; strip srcset so it can't bypass it.
 *  Also removes lazy-loading so images load immediately (iframe has no scroll, so they'd never enter viewport). */
function proxifyEmailImages(html: string): string {
  return html
    .replace(
      /(<img\b[^>]*?\ssrc\s*=\s*)(["'])(https?:\/\/[^"']+)\2/gi,
      (_match, prefix, quote, url) => `${prefix}${quote}${IMAGE_PROXY_BASE}${encodeURIComponent(url)}${quote}`
    )
    .replace(/\ssrcset\s*=\s*("[^"]*"|'[^']*')/gi, "")
    .replace(/\sloading\s*=\s*["']lazy["']/gi, "");
}
const MAX_LABEL_CACHE = 5;
const STARTUP_NETWORK_DELAY_MS = 5000;
const STARTUP_UPDATE_DELAY_MS = 9000;
const MAIL_TABS = new Set(["inbox", "sent", "archive", "spam", "trash"]);
const AUTH_RELOGIN_MESSAGE = "Oturum yenilenemedi. Lütfen tekrar giriş yapın.";

function isNoUpdateError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return /no update|not available|up to date|guncel|güncel|204/.test(message);
}

function isAuthFailure(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return /401|unauthorized|invalid_grant|invalid credentials|unauthenticated|autherror|expected oauth 2 access token|no refresh token|oturum yenilenemedi/.test(message);
}

function byteLength(text: string): number {
  return new Blob([text]).size;
}

function buildRenderableEmailHtml(html: string, fallback: string, mode: RenderMode): string {
  if (mode === "simple" || byteLength(html) > LARGE_BODY_RENDER_LIMIT) {
    const plain = stripHtml(html || fallback);
    return `<div class="plain-text">${escapeHtml(plain || fallback || "").replace(/\n/g, "<br/>")}</div>`;
  }

  const sanitized = sanitizeEmailHtml(html, fallback).replace(
    new RegExp(`\\s(src|href)\\s*=\\s*(["'])data:([^"']{${MAX_INLINE_DATA_URI},})\\2`, "gi"),
    ""
  );
  return proxifyEmailImages(sanitized);
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

type OtpMode = "off" | "balanced" | "strict";
type RenderMode = "full" | "simple";
type MailZoom = "fit" | number;

const ZOOM_STEPS = [0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.25, 1.5, 1.75, 2];
const MIN_ZOOM = ZOOM_STEPS[0];
const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1];

function readMailZoom(): MailZoom {
  const saved = localStorage.getItem("fursoy_mail_zoom");
  if (!saved || saved === "fit") return "fit";
  const value = parseFloat(saved);
  return Number.isFinite(value) ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value)) : "fit";
}
type DensityMode = "comfortable" | "compact";
type MailViewMode = "split" | "single-toggle" | "inbox-first";
type MailViewPreference = "auto" | MailViewMode;

function getAutoMailViewMode(width: number): MailViewMode {
  if (width < 900) return "inbox-first";
  return "split";
}

function readThemePreset(): ThemePresetName {
  const saved = localStorage.getItem("fursoy_theme_preset");
  return saved && saved in themePresets ? saved as ThemePresetName : "blue";
}

/** Detect OTP / verification codes using advanced context scoring. */
function extractVerificationCode(email: { subject: string; snippet: string; body_html: string }, mode: OtpMode = "balanced"): string | null {
  if (mode === "off") return null;
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
    const hasDirectOtpPrefix = directPrefix.test(contextStr) || DIRECT_OTP_PREFIX_RE.test(before);
    if (hasDirectOtpPrefix) c.score += 140;
    if (mode === "strict" && !hasDirectOtpPrefix) c.score -= 100;
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

  const validCandidates = candidates.filter(c => c.score >= (mode === "strict" ? 140 : 70));
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

interface EmailSummary {
  id: string;
  thread_id: string;
  sender: string;
  recipient: string;
  cc: string;
  subject: string;
  snippet: string;
  date: number;
  unread: boolean;
  label: string;
}

interface MailDebugMetrics {
  openedCount: number;
  lastBodyBytes: number;
  cachedLabels: number;
  cachedMessages: number;
}

function resolveEmailUrl(url: string | null | undefined): string | null {
  if (!url || url.startsWith("#")) return null;
  try {
    const resolved = new URL(url, "https://mail.google.com/").href;
    return /^(https?:|mailto:|tel:)/i.test(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

function findEmailUrl(eventTarget: EventTarget | null): string | null {
  // Use duck-typing instead of `instanceof Element` — click targets from a sandboxed
  // iframe's document are instances of the IFRAME's Element class, not the parent's,
  // so a cross-frame instanceof check always returns false even for same-origin iframes.
  if (!eventTarget || typeof (eventTarget as unknown as Record<string, unknown>).closest !== "function") return null;
  const node = eventTarget as Element;
  const link = node.closest("a[href], area[href]") as HTMLAnchorElement | HTMLAreaElement | null;
  if (link) return resolveEmailUrl(link.getAttribute("href") || link.href);

  const button = node.closest("button, input[type='button'], input[type='submit'], [role='button']") as HTMLElement | null;
  const form = button?.closest("form") as HTMLFormElement | null;
  return resolveEmailUrl(
    button?.getAttribute("formaction") ||
    button?.getAttribute("data-href") ||
    button?.getAttribute("data-url") ||
    form?.getAttribute("action")
  );
}

/** Wrap sanitized email HTML in an isolated document for the iframe. */
function buildEmailSrcDoc(html: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/>
    <style>
      /* overflow:hidden prevents the iframe's own scrollbar — the outer container scrolls. */
      html, body { margin: 0; padding: 0; background: #fff; overflow: hidden; }
      * { box-sizing: border-box; }
      .mail-root {
        display: block; width: 100%; min-width: 0; padding: 0;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        font-size: 15px; line-height: 1.6; color: #1a1a1a;
      }
      /* Plain-text emails need explicit padding; HTML emails provide their own spacing. */
      .mail-root > .plain-text { padding: 20px 24px; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; max-width: 720px; }
      img, video { height: auto; }
      a { color: #2563eb; }
      ::selection { background: rgba(59, 130, 246, 0.25); }
    </style></head>
    <body><div class="mail-root">${html}</div></body></html>`;
}

/**
 * Render an email inside a sandboxed iframe at its natural width, then scale the
 * whole frame to fit (or to a user-chosen zoom). No max-width forcing — layouts
 * stay intact; scaling never distorts and never forces a horizontal scroll in fit mode.
 */
function EmailHtmlView({
  html,
  zoom,
  relayoutKey,
  onFitScaleChange,
  onOpenUrl,
  scrollRef,
}: {
  html: string;
  zoom: MailZoom;
  /** Changing this (layout mode / window width) forces a re-measure even without a ResizeObserver hit. */
  relayoutKey?: string | number;
  onFitScaleChange?: (scale: number) => void;
  onOpenUrl: (url: string) => void;
  /** Outer scroll container — wheel events from the iframe are forwarded here. */
  scrollRef?: React.RefObject<HTMLElement | null>;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);

  const applyScale = useCallback(() => {
    const host = hostRef.current;
    const stage = stageRef.current;
    const frame = frameRef.current;
    if (!host || !stage || !frame) return;
    const doc = frame.contentDocument;
    const root = doc?.querySelector(".mail-root") as HTMLElement | null;
    if (!doc || !root) return;

    const available = Math.max(1, host.clientWidth);

    if (zoom === "fit") {
      // Gmail/Outlook-style fit:
      //   1. Render the email at the full panel width — the email's own background fills edge-to-edge.
      //   2. If the content still overflows (a truly wide fixed-layout newsletter), scale the whole
      //      frame down so nothing is clipped. Never scale UP — a narrow email stays at natural size.
      frame.style.height = "auto";
      frame.style.width = `${available}px`;

      const overflowWidth = root.scrollWidth; // > available means content spills out
      if (overflowWidth > available + 1) {
        // Content overflows — scale down proportionally, like a zoomed-out desktop view.
        const fitScale = available / overflowWidth;
        frame.style.width = `${overflowWidth}px`;
        const layoutHeight = Math.max(root.scrollHeight, doc.documentElement.scrollHeight, 1);
        frame.style.height = `${layoutHeight}px`;
        frame.style.transform = `scale(${fitScale})`;
        stage.style.width = `${Math.floor(overflowWidth * fitScale)}px`;
        stage.style.height = `${Math.floor(layoutHeight * fitScale)}px`;
        onFitScaleChange?.(fitScale);
      } else {
        // Email fits or is narrower — render at full panel width, no transform.
        // Narrow newsletters center themselves via their own margin/align rules inside the iframe.
        const layoutHeight = Math.max(root.scrollHeight, doc.documentElement.scrollHeight, 1);
        frame.style.height = `${layoutHeight}px`;
        frame.style.transform = "none";
        stage.style.width = `${available}px`;
        stage.style.height = `${layoutHeight}px`;
        onFitScaleChange?.(1);
      }
      return;
    }

    // Manual zoom mode: probe intrinsic width then apply CSS transform.
    // Fluid emails reflow at (available ÷ zoom) so text stays readable at any zoom level;
    // fixed-layout emails keep their design width and are only scaled.
    frame.style.height = "auto";
    frame.style.width = "0px";
    const minContentWidth = Math.max(root.scrollWidth, 1);

    let layoutWidth: number;
    if (minContentWidth >= FIXED_LAYOUT_MIN_WIDTH) {
      layoutWidth = minContentWidth;
    } else {
      const target = Math.max(80, Math.round(available / zoom));
      frame.style.width = `${target}px`;
      layoutWidth = Math.max(root.scrollWidth, target);
    }

    frame.style.width = `${layoutWidth}px`;
    const layoutHeight = Math.max(root.scrollHeight, doc.documentElement.scrollHeight, 1);
    frame.style.height = `${layoutHeight}px`;
    frame.style.transform = `scale(${zoom})`;
    stage.style.width = `${Math.floor(layoutWidth * zoom)}px`;
    stage.style.height = `${Math.floor(layoutHeight * zoom)}px`;
  }, [zoom, onFitScaleChange]);

  const applyScaleRef = useRef(applyScale);
  applyScaleRef.current = applyScale;

  // Load HTML into the iframe and wire up measuring + link handling.
  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    let innerCleanup: (() => void) | null = null;

    const handleLoad = () => {
      const doc = frame.contentDocument;
      if (!doc) return;

      // Navigation-detection fallback: if the iframe navigated away from our email document
      // (the click handler should have prevented it, but just in case), restore the email
      // and open the external URL in the system browser.
      if (!doc.querySelector(".mail-root")) {
        const navUrl = (() => {
          try { return frame.contentWindow?.location.href ?? null; } catch { return null; }
        })();
        // Restore our email
        frame.srcdoc = buildEmailSrcDoc(html);
        // Open the external URL externally if we could read it
        if (navUrl && navUrl !== "about:blank" && /^https?:/i.test(navUrl)) {
          onOpenUrl(navUrl);
        }
        return;
      }

      const remeasure = () => applyScaleRef.current();
      remeasure();

      // Re-measure after all images load (height changes as images render).
      const images = Array.from(doc.images);
      images.forEach((img) => img.addEventListener("load", remeasure));

      // Re-measure after custom fonts load — font swap changes text reflow and height.
      doc.fonts?.ready.then(remeasure).catch(() => {});

      // Forward wheel events from the iframe to the outer scroll container.
      // Wheel events inside an iframe don't propagate to the parent document at all.
      //
      // We implement our own easing (lerp toward accumulated target) instead of
      // scrollBy({ behavior:'smooth' }) because multiple overlapping smooth calls in
      // WebView2 produce competing animations that stutter and cause perceived lag.
      let targetScrollTop = -1; // -1 = not yet initialized from current scroll position
      let smoothRaf = 0;
      const handleWheel = (e: WheelEvent) => {
        const outer = scrollRef?.current;
        if (!outer) return;
        // Normalise delta to pixels (deltaMode: 0=px, 1=lines, 2=pages).
        let dy = e.deltaY;
        const dx = e.deltaX;
        if (e.deltaMode === 1) { dy *= 40; }
        else if (e.deltaMode === 2) { dy *= outer.clientHeight; }
        if (targetScrollTop < 0) targetScrollTop = outer.scrollTop;
        const maxScroll = outer.scrollHeight - outer.clientHeight;
        targetScrollTop = Math.max(0, Math.min(maxScroll, targetScrollTop + dy));
        if (dx !== 0) outer.scrollLeft += dx;
        if (!smoothRaf) {
          const step = () => {
            const diff = targetScrollTop - outer.scrollTop;
            if (Math.abs(diff) < 0.5) {
              outer.scrollTop = targetScrollTop;
              smoothRaf = 0;
              return;
            }
            // Ease-out: close 20 % of remaining distance each frame.
            outer.scrollTop += diff * 0.2;
            smoothRaf = requestAnimationFrame(step);
          };
          smoothRaf = requestAnimationFrame(step);
        }
      };
      doc.addEventListener("wheel", handleWheel, { passive: true });

      // Intercept clicks on links/buttons before the iframe's own navigation handler.
      // NOTE: event.target instanceof Element fails for cross-frame elements even with
      // allow-same-origin; findEmailUrl already uses duck-typing to handle this.
      const handleClick = (event: Event) => {
        const url = findEmailUrl(event.target);
        // Block default on any anchor/button — the iframe must never navigate itself.
        // Check both the resolved URL and the DOM ancestry so even unresolvable links
        // (javascript:, empty href, etc.) don't trigger iframe navigation.
        const isInteractive = url !== null ||
          !!(event.target as Element | null)?.closest?.("a, area, button, [role='button']");
        if (isInteractive) event.preventDefault();
        if (!url) return;
        event.stopPropagation();
        onOpenUrl(url);
      };
      const handleSubmit = (event: Event) => {
        const node = event.target as Element | null;
        const form = node?.closest?.("form") as HTMLFormElement | null;
        const url = resolveEmailUrl(form?.getAttribute("action"));
        if (!url) return;
        event.preventDefault();
        event.stopPropagation();
        onOpenUrl(url);
      };
      doc.addEventListener("click", handleClick, true);
      doc.addEventListener("submit", handleSubmit, true);

      innerCleanup = () => {
        cancelAnimationFrame(smoothRaf);
        images.forEach((img) => img.removeEventListener("load", remeasure));
        doc.removeEventListener("wheel", handleWheel);
        doc.removeEventListener("click", handleClick, true);
        doc.removeEventListener("submit", handleSubmit, true);
      };
    };

    frame.addEventListener("load", handleLoad);
    frame.srcdoc = buildEmailSrcDoc(html);

    return () => {
      frame.removeEventListener("load", handleLoad);
      innerCleanup?.();
    };
  }, [html, onOpenUrl, scrollRef]);

  // Re-scale when zoom/relayoutKey changes or the panel resizes.
  // Merged into one effect so ResizeObserver and relayoutKey changes don't schedule
  // competing rAFs. The 260ms settle-timer is reset on every resize event so it only
  // fires once the panel has stopped moving (CSS transitions are ~200ms).
  useEffect(() => {
    let raf = 0;
    let timer = 0;
    const schedule = () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      raf = requestAnimationFrame(() => {
        applyScale();
        timer = window.setTimeout(() => applyScale(), 260);
      });
    };
    schedule();
    const host = hostRef.current;
    if (!host) return () => { cancelAnimationFrame(raf); clearTimeout(timer); };
    const resizeObserver = new ResizeObserver(schedule);
    resizeObserver.observe(host);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      resizeObserver.disconnect();
    };
  }, [applyScale, relayoutKey]);

  return (
    <div ref={hostRef} className="relative w-full min-w-0 overflow-x-auto overflow-y-hidden overscroll-contain bg-white select-text">
      <div ref={stageRef} className="relative mx-auto">
        <iframe
          ref={frameRef}
          title="E-posta içeriği"
          sandbox="allow-same-origin allow-popups"
          className="absolute left-0 top-0 block border-0 bg-white"
          style={{ transformOrigin: "top left", width: 0, height: 0 }}
        />
      </div>
    </div>
  );
}

interface AuthInfo {
  access_token: string;
  email: string;
  picture: string;
}

interface AppControls {
  notificationsMuted: boolean;
  mailSyncPaused: boolean;
  quietHoursEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
}

const DEFAULT_APP_CONTROLS: AppControls = {
  notificationsMuted: false,
  mailSyncPaused: false,
  quietHoursEnabled: false,
  quietHoursStart: "22:00",
  quietHoursEnd: "08:00",
};

function minutesFromTime(value: string): number {
  const [hours, minutes] = value.split(":").map(part => parseInt(part, 10));
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return 0;
  return Math.max(0, Math.min(23, hours)) * 60 + Math.max(0, Math.min(59, minutes));
}

function isInQuietHours(controls: AppControls): boolean {
  if (!controls.quietHoursEnabled) return false;
  const now = new Date();
  const current = now.getHours() * 60 + now.getMinutes();
  const start = minutesFromTime(controls.quietHoursStart);
  const end = minutesFromTime(controls.quietHoursEnd);
  if (start === end) return true;
  if (start < end) return current >= start && current < end;
  return current >= start || current < end;
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
    return localStorage.getItem("fursoy_pause_on_fullscreen") !== "false";
  });
  const [launchAtStartup, setLaunchAtStartup] = useState(false);
  const [startupSettingLoading, setStartupSettingLoading] = useState(false);
  const [lazyBodyLoading, setLazyBodyLoading] = useState(() => {
    return localStorage.getItem("fursoy_lazy_body_loading") !== "false";
  });
  const [renderMode, setRenderMode] = useState<RenderMode>(() => {
    return localStorage.getItem("fursoy_render_mode") === "simple" ? "simple" : "full";
  });
  const [mailZoom, setMailZoom] = useState<MailZoom>(() => readMailZoom());
  /** Auto fit-to-width scale reported by the reader (used to label the zoom control). */
  const [mailFitScale, setMailFitScale] = useState(1);
  const [appControls, setAppControls] = useState<AppControls>(DEFAULT_APP_CONTROLS);
  const [otpMode, setOtpMode] = useState<OtpMode>(() => {
    const saved = localStorage.getItem("fursoy_otp_mode");
    return saved === "off" || saved === "strict" ? saved : "balanced";
  });
  const [themePreset, setThemePreset] = useState<ThemePresetName>(() => readThemePreset());
  const [densityMode, setDensityMode] = useState<DensityMode>(() => {
    return localStorage.getItem("fursoy_density_mode") === "compact" ? "compact" : "comfortable";
  });
  const [mailViewPreference, setMailViewPreference] = useState<MailViewPreference>(() => {
    const saved = localStorage.getItem("fursoy_mail_view_mode");
    return saved === "split" || saved === "single-toggle" || saved === "inbox-first" ? saved : "auto";
  });
  const [windowWidth, setWindowWidth] = useState(() => window.innerWidth);
  const [singlePanelView, setSinglePanelView] = useState<"list" | "reader">("list");
  const [emails, setEmails] = useState<EmailSummary[]>([]);
  const [selectedMailBody, setSelectedMailBody] = useState("");
  const [selectedMailBodyId, setSelectedMailBodyId] = useState<string | null>(null);
  const [isBodyLoading, setIsBodyLoading] = useState(false);
  const [bodyError, setBodyError] = useState<string | null>(null);
  const [debugMetrics, setDebugMetrics] = useState<MailDebugMetrics>({
    openedCount: 0,
    lastBodyBytes: 0,
    cachedLabels: 0,
    cachedMessages: 0,
  });
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [userInfo, setUserInfo] = useState<AuthInfo | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [showReply, setShowReply] = useState(false);
  const [replyMode, setReplyMode] = useState<"reply" | "reply-all">("reply");
  const [replyText, setReplyText] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [showCompose, setShowCompose] = useState(false);
  const [confirmModal, setConfirmModal] = useState<{ message: string; onConfirm: () => void } | null>(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [readingToolsOpen, setReadingToolsOpen] = useState(false);
  const [isWindowMaximized, setIsWindowMaximized] = useState(false);
  const [composeTo, setComposeTo] = useState("");
  const [composeSubject, setComposeSubject] = useState("");
  const [composeBody, setComposeBody] = useState("");
  const [composeHtmlAppend, setComposeHtmlAppend] = useState("");
  const [toasts, setToasts] = useState<{ id: number; msg: string; type: 'error' | 'success' | 'info' }[]>([]);
  const [verificationCopyState, setVerificationCopyState] = useState<"idle" | "copied">("idle");
  const [inboxUnread, setInboxUnread] = useState(0);
  const [tokenExpired, setTokenExpired] = useState(false);

  // Updater States
  const [currentVersion, setCurrentVersion] = useState<string>("");
  const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
  const [updateAvailable, setUpdateAvailable] = useState<{ version: string, date: string, body: string } | null>(null);
  const [updateProgress, setUpdateProgress] = useState<{ downloaded: number, total: number } | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const [updateStatus, setUpdateStatus] = useState<string>("");

  const searchInputRef = useRef<HTMLInputElement>(null);
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const mailScrollRef = useRef<HTMLDivElement>(null);
  const syncIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const recentNotificationsRef = useRef<Record<string, string>>({});
  const notifiedUpdateVersionRef = useRef<string | null>(null);
  const lastToastRef = useRef<{ msg: string; type: "error" | "success" | "info"; at: number } | null>(null);
  const previousAutoMailViewModeRef = useRef<MailViewMode | null>(null);
  const tokenExpiredRef = useRef(tokenExpired);
  /** Latest access token for interval/manual sync (avoids stale closure + matches React state). */
  const accessTokenRef = useRef<string | null>(null);
  const backgroundSyncRef = useRef<
    (tokenOverride?: string | null, opts?: { userInitiated?: boolean }) => Promise<boolean>
  >(async () => false);
  const knownEmailIdsRef = useRef<Set<string>>(new Set());
  const recentlyReadRef = useRef<Set<string>>(new Set());
  const isFirstSyncRef = useRef(true);
  const tabEmailCacheRef = useRef<Partial<Record<string, EmailSummary[]>>>({});
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
  const appControlsRef = useRef(appControls);
  appControlsRef.current = appControls;
  tokenExpiredRef.current = tokenExpired;

  useEffect(() => {
    accessTokenRef.current = accessToken;
  }, [accessToken]);

  useEffect(() => {
    const handleResize = () => {
      setWindowWidth(window.innerWidth);
    };

    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  useEffect(() => {
    const window = getCurrentWindow();
    let disposed = false;
    let unlistenResize: (() => void) | undefined;

    const syncMaximizedState = async () => {
      try {
        const maximized = await window.isMaximized();
        if (!disposed) {
          setIsWindowMaximized(maximized);
        }
      } catch (err) {
        console.error("Failed to read window maximized state:", err);
      }
    };

    void syncMaximizedState();
    window
      .onResized(() => {
        void syncMaximizedState();
      })
      .then((unlisten) => {
        if (disposed) {
          unlisten();
        } else {
          unlistenResize = unlisten;
        }
      })
      .catch((err) => {
        console.error("Failed to listen for window resize:", err);
      });

    return () => {
      disposed = true;
      unlistenResize?.();
    };
  }, []);

  useEffect(() => {
    const preset = themePresets[themePreset];
    const root = document.documentElement;
    root.style.setProperty("--app-accent", preset.accent);
    root.style.setProperty("--app-accent-hover", preset.accentHover);
    root.style.setProperty("--app-accent-soft", preset.accentSoft);
    root.dataset.density = densityMode;
  }, [themePreset, densityMode]);

  useEffect(() => {
    getVersion()
      .then(setCurrentVersion)
      .catch((err) => {
        console.error("Failed to read app version:", err);
      });

    invoke<boolean>("get_launch_at_startup")
      .then(setLaunchAtStartup)
      .catch((err) => {
        console.error("Failed to read startup setting:", err);
      });

    invoke<AppControls>("get_app_controls")
      .then((controls) => setAppControls({ ...DEFAULT_APP_CONTROLS, ...controls }))
      .catch((err) => {
        console.error("Failed to read app controls:", err);
      });
  }, []);

  useEffect(() => {
    const unlistenPromise = listen<AppControls>("app-controls-changed", (event) => {
      setAppControls({ ...DEFAULT_APP_CONTROLS, ...event.payload });
    });

    return () => {
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, []);

  // Toast helper
  const showToast = useCallback((msg: string, type: 'error' | 'success' | 'info' = 'info') => {
    const id = Date.now();
    const lastToast = lastToastRef.current;
    if (lastToast?.msg === msg && lastToast.type === type && id - lastToast.at < 8000) {
      return;
    }

    lastToastRef.current = { msg, type, at: id };
    setToasts(prev => {
      const deduped = prev.filter(toast => toast.msg !== msg || toast.type !== type);
      return [...deduped.slice(-2), { id, msg, type }];
    });
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 4000);
  }, []);

  const markSessionExpired = useCallback((showMessage = true) => {
    if (tokenExpiredRef.current) return;

    tokenExpiredRef.current = true;
    setTokenExpired(true);
    setAccessToken(null);
    accessTokenRef.current = null;
    setIsUserSyncing(false);
    setIsBackgroundSyncing(false);
    if (syncIntervalRef.current !== null) {
      clearInterval(syncIntervalRef.current);
      syncIntervalRef.current = null;
    }
    if (showMessage) {
      showToast(AUTH_RELOGIN_MESSAGE, "error");
    }
  }, [showToast]);

  const openExternalMailUrl = useCallback((url: string) => {
    if (!url || url.startsWith("#")) return;
    let normalized: string;
    try {
      normalized = new URL(url, "https://mail.google.com/").href;
    } catch {
      showToast(tr.actions.openLinkFailed, "error");
      return;
    }

    if (!/^(https?:|mailto:|tel:)/i.test(normalized)) {
      showToast(tr.actions.openLinkFailed, "error");
      return;
    }

    openUrl(normalized).catch((err) => {
      console.error("Failed to open mail link:", err);
      showToast(tr.actions.openLinkFailed, "error");
    });
  }, [showToast]);

  const shouldDeferNetworkForGameMode = useCallback(async (userInitiated = false) => {
    if (userInitiated || !pauseOnFullscreenRef.current) return false;
    try {
      return await invoke<boolean>("is_system_fullscreen");
    } catch (e) {
      console.error("Fullscreen check failed:", e);
      return false;
    }
  }, []);

  const checkForUpdates = async (showUIMessages = false) => {
    try {
      if (showUIMessages) setIsCheckingUpdate(true);
      setUpdateError(null);
      setUpdateStatus("");
      if (await shouldDeferNetworkForGameMode(showUIMessages)) {
        console.log("System in fullscreen/game mode, skipping automatic update check.");
        return;
      }
      const update = await check();

      if (update) {
        setUpdateAvailable({ version: update.version, date: update.date || '', body: update.body || '' });
        setUpdateStatus(tr.update.available.replace("{version}", update.version));
        if (showUIMessages) {
          showToast(`Yeni bir güncelleme mevcut: v${update.version}`, "info");
        } else if (notifiedUpdateVersionRef.current !== update.version) {
          notifiedUpdateVersionRef.current = update.version;
          await invoke("show_custom_notification", {
            title: "FURSOY Mail güncellemesi hazır",
            body: `v${update.version} sürümü indirilebilir. Güncelleme ekranını açmak için tıklayın.`,
            kind: "update",
            code: null,
            emailId: null,
            duration: 10000,
          });
        }
      } else {
        setUpdateAvailable(null);
        setUpdateStatus(tr.update.upToDate);
        if (showUIMessages) showToast("Mevcut sürüm güncel.", "success");
      }
    } catch (e) {
      console.error("Update check failed:", e);
      if (isNoUpdateError(e)) {
        setUpdateAvailable(null);
        setUpdateError(null);
        setUpdateStatus(tr.update.upToDate);
        if (showUIMessages) showToast("Mevcut sürüm güncel.", "success");
        return;
      }
      const message = e instanceof Error ? e.message : String(e);
      setUpdateError(`${tr.update.checkFailed}: ${message}`);
      setUpdateStatus("");
      if (showUIMessages) showToast("Güncelleme kontrolü başarısız.", "error");
    } finally {
      if (showUIMessages) setIsCheckingUpdate(false);
    }
  };

  const installUpdate = async () => {
    try {
      setUpdateError(null);
      setUpdateStatus("");
      const update = await check();
      if (!update) {
        setUpdateAvailable(null);
        setUpdateStatus(tr.update.upToDate);
        return;
      }
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
      if (isNoUpdateError(e)) {
        setUpdateAvailable(null);
        setUpdateError(null);
        setUpdateStatus(tr.update.upToDate);
        setUpdateProgress(null);
        return;
      }
      const message = e instanceof Error ? e.message : String(e);
      setUpdateError(`${tr.update.installFailed}: ${message}`);
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

    const unlistenUpdatePromise = listen('open-update-settings', async () => {
      setMobileMenuOpen(false);
      startTabTransition(() => setActiveTab("settings"));
      await getCurrentWindow().show();
      await getCurrentWindow().unminimize();
      await getCurrentWindow().setFocus();
      window.setTimeout(() => {
        document.getElementById("settings-updates")?.scrollIntoView({ block: "center", behavior: "smooth" });
      }, 100);
    });

    return () => {
      unlistenCustomPromise.then(unlisten => unlisten());
      unlistenPluginPromise.then(unlisten => unlisten());
      unlistenUpdatePromise.then(unlisten => unlisten());
    };
  }, []);

  // Check update on startup
  useEffect(() => {
    const timer = window.setTimeout(() => {
      void checkForUpdates(false);
    }, STARTUP_UPDATE_DELAY_MS);

    return () => window.clearTimeout(timer);
  }, []);

  // Load emails by current tab from local DB
  const loadEmails = async (tab?: string) => {
    try {
      const label = tab || activeTabRef.current;
      if (!MAIL_TABS.has(label)) {
        startDataTransition(() => setEmails([]));
        return;
      }

      const result = await invoke<EmailSummary[]>("get_emails_by_label", { label });

      // Override unread status if it was recently marked as read locally
      const adjusted = result.map(m =>
        recentlyReadRef.current.has(m.id) ? { ...m, unread: false } : m
      );

      tabEmailCacheRef.current[label] = adjusted;
      const cacheKeys = Object.keys(tabEmailCacheRef.current);
      while (cacheKeys.length > MAX_LABEL_CACHE) {
        const oldest = cacheKeys.shift();
        if (oldest && oldest !== label) delete tabEmailCacheRef.current[oldest];
      }
      const cachedLabels = Object.keys(tabEmailCacheRef.current).length;
      const cachedMessages = Object.values(tabEmailCacheRef.current).reduce((sum, list) => sum + (list?.length || 0), 0);
      setDebugMetrics(prev => ({ ...prev, cachedLabels, cachedMessages }));
      startDataTransition(() => setEmails(adjusted));
    } catch (e) {
      console.error("Failed to load emails:", e);
    }
  };

  const clearPerformanceCaches = () => {
    tabEmailCacheRef.current = {};
    recentNotificationsRef.current = {};
    setSelectedMailBody("");
    setSelectedMailBodyId(null);
    setBodyError(null);
    setDebugMetrics({
      openedCount: 0,
      lastBodyBytes: 0,
      cachedLabels: 0,
      cachedMessages: 0,
    });
    void loadEmails(activeTabRef.current);
    showToast(tr.actions.clearCacheSuccess, "success");
  };

  const handleLaunchAtStartupChange = async (checked: boolean) => {
    setStartupSettingLoading(true);
    const previous = launchAtStartup;
    setLaunchAtStartup(checked);
    try {
      const actual = await invoke<boolean>("set_launch_at_startup", { enabled: checked });
      setLaunchAtStartup(actual);
      showToast(actual ? tr.startup.enabled : tr.startup.disabled, "success");
    } catch (e) {
      console.error("Failed to update startup setting:", e);
      setLaunchAtStartup(previous);
      showToast(`${tr.startup.failed}: ${e}`, "error");
    } finally {
      setStartupSettingLoading(false);
    }
  };

  const updateAppControls = async (next: AppControls) => {
    const previous = appControlsRef.current;
    const merged = { ...DEFAULT_APP_CONTROLS, ...next };
    setAppControls(merged);
    try {
      const saved = await invoke<AppControls>("set_app_controls", { controls: merged });
      setAppControls({ ...DEFAULT_APP_CONTROLS, ...saved });
    } catch (e) {
      console.error("Failed to update app controls:", e);
      setAppControls(previous);
      showToast(`Ayar kaydedilemedi: ${e}`, "error");
    }
  };

  // Auto-refresh token and retry on 401
  const syncWithAutoRefresh = useCallback(async (token: string): Promise<string> => {
    try {
      await invoke("sync_emails", { accessToken: token });
      return token;
    } catch (e: unknown) {
      if (isAuthFailure(e)) {
        try {
          const refreshed = await invoke<AuthInfo>("refresh_access_token");
          accessTokenRef.current = refreshed.access_token;
          setUserInfo(refreshed);
          setAccessToken(refreshed.access_token);
          tokenExpiredRef.current = false;
          setTokenExpired(false);
          await invoke("sync_emails", { accessToken: refreshed.access_token });
          return refreshed.access_token;
        } catch (refreshError) {
          console.error("Token refresh failed:", refreshError);
          markSessionExpired();
          throw new Error(AUTH_RELOGIN_MESSAGE);
        }
      }
      throw e;
    }
  }, [markSessionExpired]);

  // Fetch inbox unread count (always from DB, regardless of active tab)
  const refreshUnreadCount = async () => {
    try {
      const count = await invoke<number>("get_inbox_unread_count");
      startDataTransition(() => setInboxUnread(count));
      return count;
    } catch { return 0; }
  };

  const notifyNewEmails = useCallback(async (newEmails: EmailSummary[]) => {
    if (newEmails.length === 0) return;
    const controls = appControlsRef.current;
    if (controls.notificationsMuted || isInQuietHours(controls)) return;

    try {
      for (const email of newEmails.slice(0, 5)) {
        const senderName = email.sender.split("<")[0].replace(/"/g, "").trim() || email.sender;
        const body = otpMode === "off" ? "" : await invoke<string>("get_email_body", { id: email.id }).catch(() => "");
        const code = extractVerificationCode({ ...email, body_html: body }, otpMode);

        let notifTitle = senderName.slice(0, 64);
        let notifBody = (email.subject || email.snippet || "").trim().slice(0, 100) || "Yeni ileti";

        // Let the Rust backend spawn the notification window
        // It will automatically suppress it if the user is in a fullscreen game!
        await invoke("show_custom_notification", {
          title: notifTitle,
          body: notifBody,
          kind: "mail",
          code: code || null,
          emailId: email.id,
          duration: notifInfiniteRef.current ? 0 : notifDurationRef.current * 1000
        });
      }
    } catch (e) {
      console.error("Notification error:", e);
    }
  }, [otpMode]);

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

    const userInitiated = opts?.userInitiated ?? false;
    if (tokenExpiredRef.current) {
      if (userInitiated) {
        markSessionExpired();
      }
      return false;
    }

    if (appControlsRef.current.mailSyncPaused && !userInitiated) {
      return false;
    }

    if (await shouldDeferNetworkForGameMode(userInitiated)) {
      console.log("System in fullscreen/game mode, skipping background sync.");
      return false;
    }

    try {
      if (userInitiated) setIsUserSyncing(true);
      else setIsBackgroundSyncing(true);

      let hadLocalInboxSnapshot = knownEmailIdsRef.current.size > 0;
      if (isFirstSyncRef.current && !hadLocalInboxSnapshot) {
        try {
          const localInbox = await invoke<EmailSummary[]>("get_emails_by_label", { label: "inbox" });
          knownEmailIdsRef.current = new Set(localInbox.map(e => e.id));
          hadLocalInboxSnapshot = localInbox.length > 0;
        } catch (snapshotError) {
          console.error("Initial inbox snapshot failed:", snapshotError);
        }
      }

      const newToken = await syncWithAutoRefresh(token);
      accessTokenRef.current = newToken;

      const freshInbox = await invoke<EmailSummary[]>("get_emails_by_label", { label: "inbox" });

      const newUnreadEmails = freshInbox.filter(
        e => e.unread && !knownEmailIdsRef.current.has(e.id)
      );

      knownEmailIdsRef.current = new Set(freshInbox.map(e => e.id));

      if (isFirstSyncRef.current) {
        isFirstSyncRef.current = false;
        if (hadLocalInboxSnapshot) {
          notifyNewEmails(newUnreadEmails);
        }
      } else {
        notifyNewEmails(newUnreadEmails);
      }

      if (MAIL_TABS.has(activeTabRef.current)) {
        await loadEmails();
      }
      await refreshUnreadCount();
      return true;
    } catch (e) {
      console.error("Background sync failed:", e);
      if (isAuthFailure(e)) {
        markSessionExpired();
        return false;
      }
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
    let cancelled = false;
    let startupSyncTimer: number | null = null;

    refreshUnreadCount();

    invoke<AuthInfo | null>("get_auth_info")
      .then((info) => {
        if (!info) return;

        setUserInfo(info);
        setAccessToken(info.access_token);
        accessTokenRef.current = info.access_token;

        startupSyncTimer = window.setTimeout(() => {
          void (async () => {
            if (cancelled) return;
            if (await shouldDeferNetworkForGameMode(false)) {
              console.log("System in fullscreen/game mode, delaying startup token refresh and sync.");
            } else {
              let activeToken = info.access_token;
              try {
                const refreshed = await invoke<AuthInfo>("refresh_access_token");
                if (cancelled) return;
                setUserInfo(refreshed);
                setAccessToken(refreshed.access_token);
                accessTokenRef.current = refreshed.access_token;
                activeToken = refreshed.access_token;
              } catch (refreshError) {
                if (isAuthFailure(refreshError)) {
                  markSessionExpired();
                  return;
                }
                console.log("Token refresh skipped, using existing token", refreshError);
              }

              if (!cancelled) {
                await backgroundSyncRef.current(activeToken);
              }
            }

            if (!cancelled) {
              startPeriodicSync();
            }
          })();
        }, STARTUP_NETWORK_DELAY_MS);
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
        openExternalMailUrl(e.data.url);
      }
    };
    window.addEventListener("message", handleIframeMessage);

    return () => {
      cancelled = true;
      if (startupSyncTimer !== null) {
        window.clearTimeout(startupSyncTimer);
      }
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("message", handleIframeMessage);
      clearPeriodicSync();
      unlistenFocus.then(f => f());
    };
  }, [openExternalMailUrl, shouldDeferNetworkForGameMode, markSessionExpired]);

  useEffect(() => {
    if (!MAIL_TABS.has(activeTab)) {
      startDataTransition(() => setEmails([]));
      return;
    }

    const cached = tabEmailCacheRef.current[activeTab];
    if (cached !== undefined) {
      setEmails(cached);
    }
    void loadEmails(activeTab);
  }, [activeTab]);

  useEffect(() => {
    if (activeTab !== "settings") return;
    const timer = window.setTimeout(() => {
      invoke<boolean>("get_launch_at_startup")
        .then(setLaunchAtStartup)
        .catch((err) => {
          console.error("Failed to refresh startup setting:", err);
        });
    }, 250);

    return () => window.clearTimeout(timer);
  }, [activeTab]);

  const goToTab = (tab: typeof activeTab) => {
    setSelectedMail(null);
    setShowReply(false);
    setSinglePanelView("list");
    setMobileMenuOpen(false);
    startTabTransition(() => setActiveTab(tab));
  };

  async function loginWithGoogle() {
    try {
      setAuthStatus(tr.auth.waitingForBrowser);
      const res = await invoke<AuthInfo>("start_google_oauth");
      setUserInfo(res);
      setAccessToken(res.access_token);
      accessTokenRef.current = res.access_token;
      setAuthStatus(tr.auth.loggedInSyncing);
      tokenExpiredRef.current = false;
      setTokenExpired(false);

      const ok = await backgroundSyncRef.current(res.access_token, { userInitiated: true });
      if (ok) {
        setAuthStatus(tr.auth.syncComplete);
        showToast("Giriş başarılı!", "success");
      } else {
        setAuthStatus(tr.auth.syncFailedAfterLogin);
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
      tokenExpiredRef.current = false;
      setTokenExpired(false);
      setEmails([]);
      setSelectedMail(null);
      setSelectedMailBody("");
      setSelectedMailBodyId(null);
      setAuthStatus(tr.auth.loggedOut);
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

  const handleMailClick = async (mail: EmailSummary) => {
    setSelectedMail(mail.id);
    if (mailViewMode !== "split") {
      setSinglePanelView("reader");
    }
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

  const handlePermanentDelete = (emailId: string) => {
    if (!accessToken) return;
    setConfirmModal({
      message: "Bu e-posta kalıcı olarak silinsin mi? Bu işlem geri alınamaz.",
      onConfirm: async () => {
        setEmails(prev => prev.filter(e => e.id !== emailId));
        setSelectedMail(null);
        try {
          await invoke("permanently_delete", { accessToken, messageId: emailId });
          showToast("Kalıcı olarak silindi", "success");
        } catch (e) {
          showToast("Silme başarısız", "error");
          loadEmails(activeTabRef.current);
        }
      },
    });
  };

  const handleReply = async () => {
    if (!accessToken || !activeMail || !replyText.trim()) return;
    setIsSending(true);
    try {
      const extractAddress = (raw: string) => {
        const m = raw.match(/<([^>]+)>/);
        return m ? m[1].trim() : raw.trim();
      };

      const senderAddr = extractAddress(activeMail.sender);

      let toField: string;
      if (replyMode === "reply-all") {
        const ccAddrs = activeMail.cc
          .split(",")
          .map(a => extractAddress(a.trim()))
          .filter(a => a.length > 0);
        toField = [senderAddr, ...ccAddrs].join(", ");
      } else {
        toField = senderAddr;
      }

      const quotedDate = formatDateFull(activeMail.date);
      const quotedHtml = `<br/><br/><div style="border-left:3px solid #ccc;padding-left:12px;color:#888;margin-top:8px"><div style="margin-bottom:6px;font-size:12px">On ${quotedDate}, <b>${activeMail.sender}</b> wrote:</div>${selectedMailBody || activeMail.snippet}</div>`;

      await invoke("send_reply", {
        accessToken,
        to: toField,
        subject: activeMail.subject,
        body: replyText.replace(/\n/g, "<br/>") + quotedHtml,
        threadId: activeMail.thread_id || activeMail.id,
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
      const body = composeBody.replace(/\n/g, "<br/>") + composeHtmlAppend;
      await invoke("send_email", {
        accessToken,
        to: composeTo,
        subject: composeSubject,
        body,
      });
      setShowCompose(false);
      setComposeTo("");
      setComposeSubject("");
      setComposeBody("");
      setComposeHtmlAppend("");
    } catch (e) {
      showToast("Gönderim başarısız", "error");
    }
    setIsSending(false);
  };

  const handleMarkAsUnread = async (emailId: string) => {
    if (!accessToken) return;
    recentlyReadRef.current.delete(emailId);
    setEmails(prev => prev.map(m => m.id === emailId ? { ...m, unread: true } : m));
    try {
      await invoke("mark_as_unread", { accessToken, messageId: emailId });
      await refreshUnreadCount();
    } catch (e) {
      showToast("İşlem başarısız", "error");
      loadEmails(activeTabRef.current);
    }
  };

  const handleForward = (mail: EmailSummary) => {
    const fwdHeader = `<br/><br/><div style="border-top:1px solid #eee;padding-top:12px;color:#555;font-size:13px"><b>---------- İletilen Mesaj ----------</b><br/>Kimden: ${mail.sender}<br/>Konu: ${mail.subject}<br/>Tarih: ${formatDateFull(mail.date)}<br/><br/></div>`;
    setComposeTo("");
    setComposeSubject(`Fwd: ${mail.subject.replace(/^(Fwd:\s*)+/i, "")}`);
    setComposeBody("");
    setComposeHtmlAppend(fwdHeader + (selectedMailBody || mail.snippet));
    setShowCompose(true);
  };

  const openReply = (mode: "reply" | "reply-all") => {
    setReplyMode(mode);
    setShowReply(true);
    setTimeout(() => replyRef.current?.focus(), 100);
  };

  const activeMail = emails.find(m => m.id === selectedMail);
  const selectedMailViewMode = mailViewPreference === "auto" ? getAutoMailViewMode(windowWidth) : mailViewPreference;
  const mailViewMode = selectedMailViewMode === "single-toggle" ? "split" : selectedMailViewMode;

  useEffect(() => {
    if (mailViewPreference !== "auto") {
      previousAutoMailViewModeRef.current = null;
      return;
    }

    const previousMode = previousAutoMailViewModeRef.current;
    if (previousMode && previousMode !== mailViewMode) {
      if (mailViewMode === "split" || !selectedMail) {
        setSinglePanelView("list");
      } else {
        setSinglePanelView("reader");
      }
    }
    previousAutoMailViewModeRef.current = mailViewMode;
  }, [mailViewMode, mailViewPreference, selectedMail]);

  const closeReader = () => {
    if (selectedMailViewMode !== "single-toggle") {
      setSelectedMail(null);
    }
    setShowReply(false);
    setSinglePanelView("list");
  };

  const persistMailZoom = useCallback((zoom: MailZoom) => {
    setMailZoom(zoom);
    localStorage.setItem("fursoy_mail_zoom", zoom === "fit" ? "fit" : String(zoom));
  }, []);

  const stepMailZoom = useCallback((direction: 1 | -1) => {
    setMailZoom(prev => {
      const current = prev === "fit" ? mailFitScale : prev;
      let index = ZOOM_STEPS.findIndex(step => step >= current - 0.001);
      if (index === -1) index = ZOOM_STEPS.length - 1;
      // When stepping down from a value that sits between steps, land on the lower step.
      if (direction < 0 && ZOOM_STEPS[index] > current + 0.001 && index > 0) index -= 1;
      const next = Math.min(ZOOM_STEPS.length - 1, Math.max(0, index + direction));
      const value = ZOOM_STEPS[next];
      localStorage.setItem("fursoy_mail_zoom", String(value));
      return value;
    });
  }, [mailFitScale]);

  const effectiveZoomPct = Math.round((mailZoom === "fit" ? mailFitScale : mailZoom) * 100);

  useEffect(() => {
    let cancelled = false;

    setSelectedMailBody("");
    setSelectedMailBodyId(null);
    setBodyError(null);
    setIsBodyLoading(false);
    setReadingToolsOpen(false);
    if (mailScrollRef.current) mailScrollRef.current.scrollTop = 0;

    if (!selectedMail) return;

    setIsBodyLoading(true);
    invoke<string>("get_email_body", { id: selectedMail })
      .then((body) => {
        if (cancelled) return;
        setSelectedMailBody(body || "");
        setSelectedMailBodyId(selectedMail);
        setDebugMetrics(prev => ({
          ...prev,
          openedCount: prev.openedCount + 1,
          lastBodyBytes: byteLength(body || ""),
        }));
      })
      .catch((e) => {
        if (cancelled) return;
        console.error("Failed to load email body:", e);
        setBodyError(tr.mail.bodyLoadFailed);
      })
      .finally(() => {
        if (!cancelled) setIsBodyLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedMail]);

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
  const hasLoadedActiveBody = !!activeMail && selectedMailBodyId === activeMail.id;

  const verificationCode = activeMail && hasLoadedActiveBody ? extractVerificationCode({ ...activeMail, body_html: selectedMailBody }, otpMode) : null;
  const activeMailHtml = activeMail && hasLoadedActiveBody ? buildRenderableEmailHtml(selectedMailBody, activeMail.snippet, renderMode) : "";

  useEffect(() => {
    setVerificationCopyState("idle");
  }, [selectedMail, verificationCode]);

  const showArchiveBtn = activeTab === "inbox" || activeTab === "sent";
  const showRestoreBtn = activeTab === "trash" || activeTab === "spam" || activeTab === "archive";
  const showTrashToBinBtn = activeTab !== "trash";
  const showDeleteForeverBtn = activeTab === "trash";
  const isCompactSidebarMode = mailViewPreference === "single-toggle" || (mailViewPreference === "auto" && windowWidth >= 900 && windowWidth < 1280);
  const usesOverlaySidebar = windowWidth < 900 || isCompactSidebarMode;
  const showMailList = mailViewMode === "split" || !selectedMail || singlePanelView === "list";
  const showMailReader = !!activeMail && (mailViewMode === "split" || singlePanelView === "reader");
  const mailListClassName = mailViewMode === "split"
    ? `flex min-w-0 flex-col border-r border-white/5 bg-[#09090b] ${selectedMail ? "hidden md:flex md:w-80 lg:w-96" : "flex-1 md:w-80 lg:w-96 md:flex-none"}`
    : showMailList
      ? "flex min-w-0 flex-1 flex-col border-r border-white/5 bg-[#09090b]"
      : "hidden";
  const mailReaderClassName = showMailReader
    ? "flex-1 min-w-0 flex flex-col bg-[#0a0a0c] relative z-10 select-text"
    : "hidden";
  const sidebarBackdropClassName = `fixed inset-x-0 bottom-0 top-9 z-40 bg-black/55 transition-opacity duration-200 ${usesOverlaySidebar && mobileMenuOpen ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"}`;
  const sidebarClassName = usesOverlaySidebar
    ? `fixed left-0 top-9 bottom-0 z-50 flex w-56 flex-col border-r border-white/5 bg-[#0c0c0e]/95 shadow-2xl shadow-black/40 backdrop-blur-xl transition-transform duration-200 ease-out ${mobileMenuOpen ? "translate-x-0" : "-translate-x-full pointer-events-none"}`
    : "static z-auto flex w-56 flex-col border-r border-white/5 bg-[#0c0c0e] shadow-none";

  return (
    <div className="flex flex-col h-screen bg-[#09090b] text-zinc-300 font-sans overflow-hidden select-none">

      {/* CUSTOM TITLEBAR */}
      <div
        data-tauri-drag-region
        className="relative z-[60] h-9 shrink-0 flex items-center justify-between pl-2 pr-0 border-b border-white/5 bg-[#09090b]"
        style={{ WebkitAppRegion: 'drag' } as any}
        onMouseDown={(event) => {
          if (!mobileMenuOpen) return;
          if ((event.target as HTMLElement).closest("button")) return;
          setMobileMenuOpen(false);
        }}
      >
        <div data-tauri-drag-region className="flex items-center gap-2 text-xs font-medium text-zinc-500 pl-1">
          <button
            type="button"
            onClick={() => setMobileMenuOpen(open => !open)}
            className="hidden"
            style={{ WebkitAppRegion: 'no-drag' } as any}
            aria-label="Menüyü aç"
          >
            <Menu className="h-4 w-4" />
          </button>
          <img src="/logo.svg" className="w-4 h-4 object-contain" alt="MailApp Logo" />
          <span className="text-zinc-400">{tr.app.name}</span>
        </div>
        <div className="flex items-center" style={{ WebkitAppRegion: 'no-drag' } as any}>
          <button
            onClick={() => getCurrentWindow().minimize()}
            className="w-11 h-9 flex items-center justify-center text-zinc-500 hover:bg-white/10 hover:text-zinc-200 transition-colors"
          >
            <Minus className="w-4 h-4" />
          </button>
          <button
            aria-label={isWindowMaximized ? "Asagi geri yukle" : "Ekrani kapla"}
            title={isWindowMaximized ? "Asagi geri yukle" : "Ekrani kapla"}
            onClick={async () => {
              const window = getCurrentWindow();
              await window.toggleMaximize();
              setIsWindowMaximized(await window.isMaximized());
            }}
            className="w-11 h-9 flex items-center justify-center text-zinc-500 hover:bg-white/10 hover:text-zinc-200 transition-colors"
          >
            {isWindowMaximized ? <Copy className="w-3.5 h-3.5" /> : <Square className="w-3 h-3" />}
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
        <div
          className={sidebarBackdropClassName}
          onClick={() => setMobileMenuOpen(false)}
          aria-hidden={!mobileMenuOpen}
        />

        {/* SIDEBAR */}
        <aside className={sidebarClassName}>
          <nav className="flex-1 p-2 pt-3 space-y-0.5">
            <button
              onClick={() => goToTab("inbox")}
              className={`w-full flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-lg transition-all duration-200 ${activeTab === 'inbox' ? 'bg-[var(--app-accent-soft)] text-zinc-100 shadow-[inset_2px_0_0_var(--app-accent)]' : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200'}`}
            >
              <Inbox className="w-4 h-4" /> {tr.nav.inbox}
              {unreadCount > 0 && (
                <span className="ml-auto text-[10px] bg-blue-500 text-white min-w-[18px] text-center py-0.5 px-1 rounded-full font-bold">{unreadCount}</span>
              )}
            </button>
            <button
              onClick={() => goToTab("sent")}
              className={`w-full flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-lg transition-all duration-200 ${activeTab === 'sent' ? 'bg-[var(--app-accent-soft)] text-zinc-100 shadow-[inset_2px_0_0_var(--app-accent)]' : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200'}`}
            >
              <Send className="w-4 h-4" /> {tr.nav.sent}
            </button>
            <button
              onClick={() => goToTab("archive")}
              className={`w-full flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-lg transition-all duration-200 ${activeTab === 'archive' ? 'bg-[var(--app-accent-soft)] text-zinc-100 shadow-[inset_2px_0_0_var(--app-accent)]' : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200'}`}
            >
              <Archive className="w-4 h-4" /> {tr.nav.archive}
            </button>

            <div className="my-2 border-t border-white/5" />

            <button
              onClick={() => goToTab("spam")}
              className={`w-full flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-lg transition-all duration-200 ${activeTab === 'spam' ? 'bg-[var(--app-accent-soft)] text-zinc-100 shadow-[inset_2px_0_0_var(--app-accent)]' : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200'}`}
            >
              <ShieldAlert className="w-4 h-4" /> {tr.nav.spam}
            </button>
            <button
              onClick={() => goToTab("trash")}
              className={`w-full flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-lg transition-all duration-200 ${activeTab === 'trash' ? 'bg-[var(--app-accent-soft)] text-zinc-100 shadow-[inset_2px_0_0_var(--app-accent)]' : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200'}`}
            >
              <Trash2 className="w-4 h-4" /> {tr.nav.trash}
            </button>

            <div className="my-2 border-t border-white/5" />

            <button
              onClick={() => goToTab("settings")}
              className={`w-full flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-lg transition-all duration-200 ${activeTab === 'settings' ? 'bg-[var(--app-accent-soft)] text-zinc-100 shadow-[inset_2px_0_0_var(--app-accent)]' : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200'}`}
            >
              <Settings className="w-4 h-4" /> {tr.nav.settings}
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
                  <Settings className="w-4 h-4" /> {tr.auth.loginWithGoogle}
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
                <h3 className="text-sm font-semibold text-zinc-200">{composeHtmlAppend ? "İlet" : tr.compose.title}</h3>
                <button onClick={() => { setShowCompose(false); setComposeHtmlAppend(""); }} className="p-1 rounded hover:bg-white/10 text-zinc-400"><X className="w-4 h-4" /></button>
              </div>
              <div className="p-4 space-y-3 flex-1">
                <input value={composeTo} onChange={e => setComposeTo(e.target.value)} placeholder={tr.compose.to} className={ui.input} />
                <input value={composeSubject} onChange={e => setComposeSubject(e.target.value)} placeholder={tr.compose.subject} className={ui.input} />
                <textarea value={composeBody} onChange={e => setComposeBody(e.target.value)} placeholder={tr.compose.body} className={`${ui.input} resize-none min-h-[200px]`} />
              </div>
              <div className="flex items-center justify-between px-4 py-3 border-t border-white/5">
                <button onClick={() => { setShowCompose(false); setComposeHtmlAppend(""); }} className="text-xs text-zinc-500 hover:text-zinc-300">{tr.compose.discard}</button>
                <button onClick={handleComposeSend} disabled={!composeTo.trim() || !composeSubject.trim() || isSending} className="px-5 py-1.5 bg-blue-500 hover:bg-blue-600 disabled:opacity-40 text-white text-xs font-medium rounded-lg transition-colors flex items-center gap-2">
                  {isSending ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                  {isSending ? tr.compose.sending : tr.compose.send}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* MAIN CONTENT AREA */}
        {/* Settings panel — always in DOM so re-opens skip fresh mount */}
        <section
          className="flex-1 overflow-y-scroll overscroll-contain bg-[#0a0a0c] p-8"
          style={{ contain: "layout paint", display: activeTab === 'settings' ? undefined : 'none' }}
        >
            <div className="max-w-2xl mx-auto">
              <h2 className={`${typography.pageTitle} mb-6 flex items-center gap-2`}>
                {usesOverlaySidebar && (
                  <button
                    type="button"
                    onClick={() => setMobileMenuOpen(open => !open)}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-zinc-500 hover:bg-white/10 hover:text-zinc-200"
                    aria-label="Menuyu ac"
                    title="Menuyu ac"
                  >
                    <Menu className="h-4 w-4" />
                  </button>
                )}
                <Settings className="w-6 h-6" />
                {tr.nav.settings}
              </h2>

              <div className="space-y-8">
                {/* Appearance */}
                <div className="bg-white/[0.02] border border-white/5 rounded-xl p-5">
                  <h3 className="text-sm font-semibold text-zinc-200 mb-1">{tr.appearance.title}</h3>
                  <p className="text-xs text-zinc-500 mb-4">{tr.appearance.description}</p>

                  <div className="space-y-5">
                    <div>
                      <div className="text-xs font-medium text-zinc-300 mb-2">{tr.appearance.accentColor}</div>
                      <div className="flex flex-wrap gap-2">
                        {(Object.keys(themePresets) as ThemePresetName[]).map((name) => {
                          const preset = themePresets[name];
                          const active = themePreset === name;
                          return (
                            <button
                              key={name}
                              type="button"
                              onClick={() => {
                                setThemePreset(name);
                                localStorage.setItem("fursoy_theme_preset", name);
                              }}
                              className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs transition-all ${active ? "border-[var(--app-accent)] bg-[var(--app-accent-soft)] text-zinc-100" : "border-white/10 bg-[#09090b] text-zinc-400 hover:bg-white/5 hover:text-zinc-200"}`}
                            >
                              <span className="h-3.5 w-3.5 rounded-full" style={{ backgroundColor: preset.accent }} />
                              {preset.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <div>
                      <div className="text-xs font-medium text-zinc-300 mb-2">{tr.appearance.density}</div>
                      <div className="inline-flex rounded-lg border border-white/10 bg-[#09090b] p-1">
                        {(["comfortable", "compact"] as DensityMode[]).map((mode) => (
                          <button
                            key={mode}
                            type="button"
                            onClick={() => {
                              setDensityMode(mode);
                              localStorage.setItem("fursoy_density_mode", mode);
                            }}
                            className={`px-3 py-1.5 text-xs rounded-md transition-colors ${densityMode === mode ? "bg-white/10 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"}`}
                          >
                            {mode === "comfortable" ? tr.appearance.comfortable : tr.appearance.compact}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>

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

                {/* Startup */}
                <div className="bg-white/[0.02] border border-white/5 rounded-xl p-5">
                  <h3 className="text-sm font-semibold text-zinc-200 mb-1">{tr.startup.title}</h3>
                  <p className="text-xs text-zinc-500 mb-4">{tr.startup.description}</p>

                  <label className={`flex items-center gap-2 ${startupSettingLoading ? "opacity-60" : "cursor-pointer"}`}>
                    <input
                      type="checkbox"
                      checked={launchAtStartup}
                      disabled={startupSettingLoading}
                      onChange={(e) => {
                        void handleLaunchAtStartupChange(e.target.checked);
                      }}
                      className="w-4 h-4 rounded border-white/20 bg-[#09090b] text-blue-500 focus:ring-0 focus:ring-offset-0 disabled:opacity-50"
                    />
                    <span className="text-sm text-zinc-300">{tr.startup.launchAtStartup}</span>
                  </label>
                </div>

                {/* Notification and Sync Controls */}
                <div className="bg-white/[0.02] border border-white/5 rounded-xl p-5">
                  <h3 className="text-sm font-semibold text-zinc-200 mb-1">{tr.notifications.title}</h3>
                  <p className="text-xs text-zinc-500 mb-4">{tr.notifications.description}</p>

                  <div className="space-y-5">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={appControls.notificationsMuted}
                        onChange={(e) => {
                          void updateAppControls({ ...appControlsRef.current, notificationsMuted: e.target.checked });
                        }}
                        className="w-4 h-4 rounded border-white/20 bg-[#09090b] text-blue-500 focus:ring-0 focus:ring-offset-0"
                      />
                      <span className="text-sm text-zinc-300">{tr.notifications.muteNotifications}</span>
                    </label>

                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={appControls.mailSyncPaused}
                        onChange={(e) => {
                          void updateAppControls({ ...appControlsRef.current, mailSyncPaused: e.target.checked });
                        }}
                        className="w-4 h-4 rounded border-white/20 bg-[#09090b] text-blue-500 focus:ring-0 focus:ring-offset-0"
                      />
                      <span className="text-sm text-zinc-300">{tr.notifications.pauseMailSync}</span>
                    </label>

                    <div className="rounded-lg border border-white/5 bg-[#09090b] p-3">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={appControls.quietHoursEnabled}
                          onChange={(e) => {
                            void updateAppControls({ ...appControlsRef.current, quietHoursEnabled: e.target.checked });
                          }}
                          className="w-4 h-4 rounded border-white/20 bg-[#09090b] text-blue-500 focus:ring-0 focus:ring-offset-0"
                        />
                        <span className="text-sm text-zinc-300">{tr.notifications.quietHours}</span>
                      </label>
                      <p className="mt-1 text-[10px] text-zinc-600">{tr.notifications.quietHoursHint}</p>
                      <div className={`mt-3 grid grid-cols-2 gap-3 transition-opacity ${appControls.quietHoursEnabled ? "" : "opacity-40"}`}>
                        <label className="space-y-1">
                          <span className="text-[10px] text-zinc-500">{tr.notifications.start}</span>
                          <input
                            type="time"
                            value={appControls.quietHoursStart}
                            disabled={!appControls.quietHoursEnabled}
                            onChange={(e) => {
                              void updateAppControls({ ...appControlsRef.current, quietHoursStart: e.target.value });
                            }}
                            className="w-full rounded-lg border border-white/10 bg-[#0c0c0e] px-2 py-1.5 text-xs text-zinc-200 outline-none focus:border-blue-500/50 disabled:cursor-not-allowed"
                          />
                        </label>
                        <label className="space-y-1">
                          <span className="text-[10px] text-zinc-500">{tr.notifications.end}</span>
                          <input
                            type="time"
                            value={appControls.quietHoursEnd}
                            disabled={!appControls.quietHoursEnabled}
                            onChange={(e) => {
                              void updateAppControls({ ...appControlsRef.current, quietHoursEnd: e.target.value });
                            }}
                            className="w-full rounded-lg border border-white/10 bg-[#0c0c0e] px-2 py-1.5 text-xs text-zinc-200 outline-none focus:border-blue-500/50 disabled:cursor-not-allowed"
                          />
                        </label>
                      </div>
                    </div>
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

                  <div className="space-y-5">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={lazyBodyLoading}
                        onChange={(e) => {
                          const checked = e.target.checked;
                          setLazyBodyLoading(checked);
                          localStorage.setItem("fursoy_lazy_body_loading", checked.toString());
                        }}
                        className="w-4 h-4 rounded border-white/20 bg-[#09090b] text-blue-500 focus:ring-0 focus:ring-offset-0"
                      />
                      <span className="text-sm text-zinc-300">E-posta içeriğini yalnızca açıldığında yükle</span>
                    </label>

                    <div>
                      <div className="text-xs font-medium text-zinc-300 mb-2">HTML Mail Render Modu</div>
                      <div className="inline-flex rounded-lg border border-white/10 bg-[#09090b] p-1">
                        <button
                          type="button"
                          onClick={() => {
                            setRenderMode("full");
                            localStorage.setItem("fursoy_render_mode", "full");
                          }}
                          className={`px-3 py-1.5 text-xs rounded-md transition-colors ${renderMode === "full" ? "bg-white/10 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"}`}
                        >
                          Tam HTML
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setRenderMode("simple");
                            localStorage.setItem("fursoy_render_mode", "simple");
                          }}
                          className={`px-3 py-1.5 text-xs rounded-md transition-colors ${renderMode === "simple" ? "bg-white/10 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"}`}
                        >
                          Basit
                        </button>
                      </div>
                    </div>

                    <div>
                      <div className="text-xs font-medium text-zinc-300 mb-2">OTP Algılama</div>
                      <div className="inline-flex rounded-lg border border-white/10 bg-[#09090b] p-1">
                        {(["off", "balanced", "strict"] as OtpMode[]).map((mode) => (
                          <button
                            key={mode}
                            type="button"
                            onClick={() => {
                              setOtpMode(mode);
                              localStorage.setItem("fursoy_otp_mode", mode);
                            }}
                            className={`px-3 py-1.5 text-xs rounded-md transition-colors ${otpMode === mode ? "bg-white/10 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"}`}
                          >
                            {mode === "off" ? "Kapalı" : mode === "balanced" ? "Dengeli" : "Sıkı"}
                          </button>
                        ))}
                      </div>
                    </div>

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
                      <span className="text-sm text-zinc-300">Oyun/tam ekran sırasında arka plan internet işlemlerini durdur</span>
                    </label>

                    <div className="rounded-lg border border-white/5 bg-[#09090b] p-3">
                      <div className="flex items-center justify-between gap-3 mb-2">
                        <div>
                          <div className="text-xs font-medium text-zinc-300">Yaklaşık veri kullanımı</div>
                          <div className="text-[10px] text-zinc-600">Gösterilen değer WebView2 RAM kullanımını içermez.</div>
                        </div>
                        <button
                          type="button"
                          onClick={clearPerformanceCaches}
                          className="px-3 py-1.5 rounded-md border border-white/10 text-xs text-zinc-300 hover:bg-white/5"
                        >
                          Cache'i temizle
                        </button>
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-[10px] text-zinc-500">
                        <div>
                          Açılan içerik:
                          <span className="text-zinc-300"> {debugMetrics.openedCount}</span>
                        </div>
                        <div>
                          Son içerik boyutu:
                          <span className="text-zinc-300">
                            {" "}
                            {Math.round(debugMetrics.lastBodyBytes / 1024)} KB
                          </span>
                        </div>
                        <div>
                          Önbellekteki etiket:
                          <span className="text-zinc-300"> {debugMetrics.cachedLabels}</span>
                        </div>
                        <div>
                          Önbellekteki mail:
                          <span className="text-zinc-300"> {debugMetrics.cachedMessages}</span>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Updates */}
                <div id="settings-updates" className="bg-white/[0.02] border border-white/5 rounded-xl p-5">
                  <h3 className={`${typography.sectionTitle} mb-1`}>{tr.update.title}</h3>
                  <p className={`${typography.bodyMuted} mb-4`}>{tr.update.description}</p>
                  <div className="mb-4 flex items-center justify-between rounded-lg border border-white/5 bg-[#09090b] px-3 py-2">
                    <span className="text-xs text-zinc-500">{tr.update.currentVersion}</span>
                    <span className="text-xs font-semibold text-zinc-200">v{currentVersion || "..."}</span>
                  </div>

                  <div className="space-y-4">
                    {!updateProgress ? (
                      <div className="flex items-center gap-3">
                        <button
                          onClick={() => checkForUpdates(true)}
                          disabled={isCheckingUpdate}
                          className={`${ui.buttonSecondary} flex items-center gap-2`}
                        >
                          {isCheckingUpdate ? <RefreshCw className="w-4 h-4 animate-spin" /> : <DownloadCloud className="w-4 h-4" />}
                          {isCheckingUpdate ? tr.update.checking : tr.update.check}
                        </button>
                        {updateAvailable && (
                          <button
                            onClick={installUpdate}
                            className={ui.buttonPrimary}
                          >
                            {tr.update.installVersion.replace("{version}", updateAvailable.version)}
                          </button>
                        )}
                      </div>
                    ) : (
                      <div className="bg-[#09090b] border border-white/10 rounded-lg p-4">
                        <div className="flex items-center justify-between text-xs text-zinc-300 mb-2">
                          <span className="font-medium text-blue-400">{tr.update.downloading}</span>
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
                          {tr.update.restartHint}
                        </p>
                      </div>
                    )}
                    {updateError && (
                      <p className="text-xs text-red-400 font-medium">{updateError}</p>
                    )}
                    {updateStatus && !updateError && (
                      <p className="text-xs text-emerald-400 font-medium">{updateStatus}</p>
                    )}
                  </div>
                </div>
              </div>
            </div>
        </section>
        {activeTab !== 'settings' && (
          <>
            {/* MAIL LIST */}
            <section className={mailListClassName}>
              <div className="h-12 flex items-center px-4 border-b border-white/5 justify-between shrink-0">
                <div className="flex min-w-0 items-center gap-2.5">
                  {usesOverlaySidebar && (
                    <button
                      type="button"
                      onClick={() => setMobileMenuOpen(open => !open)}
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-500 hover:bg-white/10 hover:text-zinc-200"
                      aria-label="Menuyu ac"
                      title="Menuyu ac"
                    >
                      <Menu className="h-4 w-4" />
                    </button>
                  )}
                  <h2 className="min-w-0 truncate font-semibold text-zinc-100 text-sm capitalize" title={activeTab}>{activeTab}</h2>
                  {isUserSyncing && (
                    <span className="text-[10px] uppercase tracking-wider text-blue-500 font-semibold animate-pulse">Senkronize…</span>
                  )}
                  {isBackgroundSyncing && !isUserSyncing && (
                    <span className="text-[10px] text-zinc-600 font-medium">Arka planda güncelleniyor</span>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <div className="inline-flex rounded-md border border-white/10 bg-white/[0.03] p-0.5">
                    {([
                      ["auto", Settings, "Otomatik"],
                      ["split", Columns2, "Yan yana"],
                      ["single-toggle", PanelLeft, "Dar menu"],
                      ["inbox-first", Rows3, "Liste odakli"],
                    ] as const).map(([mode, Icon, label]) => (
                      <button
                        key={mode}
                        type="button"
                        title={label}
                        aria-label={label}
                        onClick={() => {
                          setMailViewPreference(mode);
                          localStorage.setItem("fursoy_mail_view_mode", mode);
                          const nextMode = mode === "auto" ? getAutoMailViewMode(windowWidth) : mode;
                          setSinglePanelView(nextMode === "split" || nextMode === "inbox-first" || !selectedMail ? "list" : singlePanelView);
                        }}
                        className={`flex h-7 w-7 items-center justify-center rounded text-zinc-500 transition-colors ${mailViewPreference === mode ? "bg-white/10 text-zinc-100" : "hover:bg-white/5 hover:text-zinc-300"}`}
                      >
                        <Icon className="h-3.5 w-3.5" />
                      </button>
                    ))}
                  </div>
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
                    {searchQuery ? tr.mail.searchEmpty : activeTab === 'inbox' ? tr.mail.emptyInbox : tr.mail.emptyFolder}
                  </div>
                )}
                {displayEmails.map((mail) => (
                  <div
                    key={mail.id}
                    onClick={() => handleMailClick(mail)}
                    className={`px-4 py-[var(--mail-row-py)] border-b border-white/[0.03] cursor-pointer transition-all duration-200 relative ${selectedMail === mail.id
                      ? 'bg-[var(--app-accent-soft)] border-l-2 border-l-[var(--app-accent)]'
                      : 'hover:bg-white/[0.02] border-l-2 border-l-transparent'
                      }`}
                  >
                    {mail.unread && <div className="absolute left-1 top-4 w-1.5 h-1.5 rounded-full bg-blue-500"></div>}
                    <div className="flex justify-between items-baseline mb-0.5 gap-2 min-w-0">
                      <span
                        className={`min-w-0 truncate text-xs ${mail.unread ? 'font-semibold text-zinc-100' : 'text-zinc-400'}`}
                        title={mail.label === 'sent' ? mail.recipient : mail.sender}
                      >
                        {mail.label === 'sent'
                          ? `To: ${(mail.recipient || '').split('<')[0].replace(/"/g, '').trim() || mail.recipient}`
                          : mail.sender.split('<')[0].replace(/"/g, '').trim()
                        }
                      </span>
                      <span className="text-[10px] text-zinc-600 shrink-0">{formatDate(mail.date)}</span>
                    </div>
                    <h3
                      className={`min-w-0 truncate text-xs ${mail.unread ? 'text-zinc-200 font-medium' : 'text-zinc-500'}`}
                      title={mail.subject}
                    >
                      {mail.subject}
                    </h3>
                    <p className="mt-0.5 min-w-0 truncate text-[11px] text-zinc-600" title={mail.snippet}>{mail.snippet}</p>
                  </div>
                ))}
              </div>
            </section>

            {/* MAIL DETAIL */}
            {activeMail ? (
              <main className={mailReaderClassName}>
                {/* Mobile Back Button */}
                <div className="md:hidden h-12 flex items-center px-4 border-b border-white/5 shrink-0">
                  <button onClick={closeReader} className="flex items-center gap-2 text-xs text-zinc-400 hover:text-zinc-200">
                    <CornerUpLeft className="w-3.5 h-3.5" /> Back
                  </button>
                </div>

                {/* Desktop Toolbar */}
                <div className="hidden md:flex h-12 items-center justify-between gap-2 px-3 lg:px-5 border-b border-white/5 shrink-0">
                  <div className="flex min-w-0 items-center gap-1.5">
                    {mailViewMode !== "split" && (
                      <button
                        type="button"
                        onClick={closeReader}
                        className="mr-1 shrink-0 rounded-md p-1.5 text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-200"
                        aria-label="Listeye don"
                        title="Listeye don"
                      >
                        <CornerUpLeft className="h-3.5 w-3.5" />
                      </button>
                    )}
                    <span className="min-w-0 truncate text-xs text-zinc-500 flex items-center gap-1.5 capitalize">
                      {activeTab === 'inbox' && <Inbox className="w-3.5 h-3.5 shrink-0" />}
                      {activeTab === 'sent' && <Send className="w-3.5 h-3.5 shrink-0" />}
                      {activeTab === 'archive' && <Archive className="w-3.5 h-3.5 shrink-0" />}
                      {activeTab === 'spam' && <ShieldAlert className="w-3.5 h-3.5 shrink-0" />}
                      {activeTab === 'trash' && <Trash2 className="w-3.5 h-3.5 shrink-0" />}
                      <span className="truncate">{activeTab}</span>
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5" style={{ WebkitAppRegion: "no-drag" } as CSSProperties}>
                    <ToolbarTip label="Yanıtla">
                      <button
                        type="button"
                        onClick={() => openReply("reply")}
                        className={`p-2 rounded-md hover:bg-white/5 transition-colors ${showReply && replyMode === "reply" ? 'text-blue-400 bg-blue-500/10' : 'text-zinc-400 hover:text-zinc-200'}`}
                      >
                        <CornerUpLeft className="w-4 h-4" />
                      </button>
                    </ToolbarTip>
                    {activeMail.cc && (
                      <ToolbarTip label="Tümünü yanıtla">
                        <button
                          type="button"
                          onClick={() => openReply("reply-all")}
                          className={`p-2 rounded-md hover:bg-white/5 transition-colors ${showReply && replyMode === "reply-all" ? 'text-blue-400 bg-blue-500/10' : 'text-zinc-400 hover:text-zinc-200'}`}
                        >
                          <Users className="w-4 h-4" />
                        </button>
                      </ToolbarTip>
                    )}
                    <ToolbarTip label="İlet">
                      <button
                        type="button"
                        onClick={() => handleForward(activeMail)}
                        className="p-2 rounded-md hover:bg-white/5 text-zinc-400 hover:text-zinc-200 transition-colors"
                      >
                        <Forward className="w-4 h-4" />
                      </button>
                    </ToolbarTip>
                    <ToolbarTip label="Okunmadı olarak işaretle">
                      <button
                        type="button"
                        onClick={() => handleMarkAsUnread(activeMail.id)}
                        className="p-2 rounded-md hover:bg-white/5 text-zinc-400 hover:text-zinc-200 transition-colors"
                      >
                        <Eye className="w-4 h-4" />
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
                    <div className="mx-1 hidden h-5 w-px bg-white/5 lg:block" />
                    <div className="hidden items-center rounded-md border border-white/10 bg-white/[0.03] lg:flex">
                      <ToolbarTip label={tr.reading.zoomOut}>
                        <button
                          type="button"
                          onClick={() => stepMailZoom(-1)}
                          className="flex h-7 w-7 items-center justify-center rounded-l-md text-zinc-400 hover:bg-white/5 hover:text-zinc-100"
                          aria-label={tr.reading.zoomOut}
                        >
                          <Minus className="h-3.5 w-3.5" />
                        </button>
                      </ToolbarTip>
                      <ToolbarTip label={tr.reading.fitWidthHint}>
                        <button
                          type="button"
                          onClick={() => persistMailZoom("fit")}
                          className={`flex h-7 min-w-[3.25rem] items-center justify-center gap-1 px-1 text-[11px] font-medium tabular-nums transition-colors ${mailZoom === "fit" ? "text-[var(--app-accent)]" : "text-zinc-300 hover:text-zinc-100"}`}
                          aria-label={tr.reading.fitWidth}
                        >
                          {mailZoom === "fit" && <Maximize2 className="h-3 w-3" />}
                          {effectiveZoomPct}%
                        </button>
                      </ToolbarTip>
                      <ToolbarTip label={tr.reading.zoomIn}>
                        <button
                          type="button"
                          onClick={() => stepMailZoom(1)}
                          className="flex h-7 w-7 items-center justify-center rounded-r-md text-zinc-400 hover:bg-white/5 hover:text-zinc-100"
                          aria-label={tr.reading.zoomIn}
                        >
                          <Plus className="h-3.5 w-3.5" />
                        </button>
                      </ToolbarTip>
                    </div>
                    <ToolbarTip label={tr.reading.settings}>
                      <button
                        type="button"
                        onClick={() => setReadingToolsOpen(open => !open)}
                        className={`p-2 rounded-md transition-colors ${readingToolsOpen ? "bg-[var(--app-accent-soft)] text-zinc-100" : "text-zinc-400 hover:bg-white/5 hover:text-zinc-200"}`}
                      >
                        <Settings className="w-4 h-4" />
                      </button>
                    </ToolbarTip>
                  </div>
                </div>

                <aside
                  className={`absolute bottom-0 right-0 top-12 z-20 hidden w-72 border-l border-white/10 bg-[#0c0c0e]/95 p-4 shadow-2xl shadow-black/30 backdrop-blur-xl transition-transform duration-200 md:block ${readingToolsOpen ? "translate-x-0" : "translate-x-full"}`}
                  aria-hidden={!readingToolsOpen}
                >
                  <div className="mb-4 flex items-center justify-between">
                    <h3 className="text-sm font-semibold text-zinc-200">{tr.reading.settings}</h3>
                    <button
                      type="button"
                      onClick={() => setReadingToolsOpen(false)}
                      className="rounded-md p-1 text-zinc-500 hover:bg-white/10 hover:text-zinc-200"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>

                  <div className="space-y-5">
                    <div>
                      <div className="mb-1 text-sm text-zinc-300">{tr.reading.zoom}</div>
                      <p className="mb-2 text-[11px] leading-relaxed text-zinc-600">{tr.reading.zoomHint}</p>
                      <div className="flex items-center gap-2">
                        <div className="inline-flex items-center rounded-lg border border-white/10 bg-[#09090b]">
                          <button
                            type="button"
                            onClick={() => stepMailZoom(-1)}
                            className="flex h-8 w-8 items-center justify-center text-zinc-400 hover:text-zinc-100 disabled:opacity-30"
                            aria-label={tr.reading.zoomOut}
                            title={tr.reading.zoomOut}
                          >
                            <Minus className="h-3.5 w-3.5" />
                          </button>
                          <span className="min-w-[3rem] text-center text-xs font-medium text-zinc-200 tabular-nums">{effectiveZoomPct}%</span>
                          <button
                            type="button"
                            onClick={() => stepMailZoom(1)}
                            className="flex h-8 w-8 items-center justify-center text-zinc-400 hover:text-zinc-100 disabled:opacity-30"
                            aria-label={tr.reading.zoomIn}
                            title={tr.reading.zoomIn}
                          >
                            <Plus className="h-3.5 w-3.5" />
                          </button>
                        </div>
                        <button
                          type="button"
                          onClick={() => persistMailZoom("fit")}
                          className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs transition-colors ${mailZoom === "fit" ? "border-[var(--app-accent)] bg-[var(--app-accent-soft)] text-zinc-100" : "border-white/10 bg-[#09090b] text-zinc-400 hover:text-zinc-200"}`}
                          title={tr.reading.fitWidthHint}
                        >
                          <Maximize2 className="h-3.5 w-3.5" />
                          {tr.reading.fitWidth}
                        </button>
                      </div>
                    </div>

                    <div>
                      <div className="mb-2 text-xs font-medium text-zinc-300">{tr.reading.renderMode}</div>
                      <div className="inline-flex rounded-lg border border-white/10 bg-[#09090b] p-1">
                        <button
                          type="button"
                          onClick={() => {
                            setRenderMode("full");
                            localStorage.setItem("fursoy_render_mode", "full");
                          }}
                          className={`px-3 py-1.5 text-xs rounded-md transition-colors ${renderMode === "full" ? "bg-white/10 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"}`}
                        >
                          Tam HTML
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setRenderMode("simple");
                            localStorage.setItem("fursoy_render_mode", "simple");
                          }}
                          className={`px-3 py-1.5 text-xs rounded-md transition-colors ${renderMode === "simple" ? "bg-white/10 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"}`}
                        >
                          Basit
                        </button>
                      </div>
                    </div>
                  </div>
                </aside>

                <div ref={mailScrollRef} className="flex-1 overflow-y-scroll overscroll-contain p-6 md:p-8">
                  <div className="mx-auto w-full max-w-[1040px] min-w-0">
                    <h1 className="text-xl font-bold text-zinc-100 mb-5">{activeMail.subject}</h1>

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
                        <div className="w-9 h-9 rounded-full bg-[var(--app-accent)] flex items-center justify-center text-white text-sm font-bold shrink-0">
                          {activeMail.sender.charAt(0).toUpperCase() || "U"}
                        </div>
                        <div>
                          <div className="text-sm font-medium text-zinc-200">{activeMail.sender.split('<')[0].replace(/"/g, '').trim()}</div>
                          <div className="text-[11px] text-zinc-600 mt-0.5">
                            {activeTab === 'sent' ? 'from me' : 'to me'} · {formatDateFull(activeMail.date)}
                          </div>
                          {activeMail.cc && (
                            <div className="text-[11px] text-zinc-600 mt-0.5">
                              <span className="text-zinc-700">CC:</span> {activeMail.cc}
                            </div>
                          )}
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

                    <div className="flex min-w-0 flex-col bg-white rounded-lg overflow-hidden border border-black/10">
                      {isBodyLoading ? (
                        <div className="flex min-h-[240px] items-center justify-center text-xs text-zinc-500">
                          {tr.mail.loadingBody}
                        </div>
                      ) : bodyError ? (
                        <div className="flex min-h-[240px] items-center justify-center text-xs text-red-400">
                          {bodyError}
                        </div>
                      ) : hasLoadedActiveBody ? (
                        <EmailHtmlView
                          key={activeMail.id}
                          html={activeMailHtml}
                          zoom={mailZoom}
                          relayoutKey={`${mailViewMode}|${singlePanelView}|${windowWidth}`}
                          onFitScaleChange={setMailFitScale}
                          onOpenUrl={openExternalMailUrl}
                          scrollRef={mailScrollRef}
                        />
                      ) : (
                        <div className="flex min-h-[240px] items-center justify-center text-xs text-zinc-500">
                          {tr.mail.preparingBody}
                        </div>
                      )}
                    </div>

                    {/* Reply Box */}
                    {showReply && (
                      <div className="mt-4 rounded-lg border border-white/10 bg-white/[0.02] overflow-hidden">
                        <div className="px-4 py-2.5 border-b border-white/5 flex items-center gap-2">
                          {replyMode === "reply-all" ? (
                            <Users className="w-3.5 h-3.5 text-zinc-500" />
                          ) : (
                            <CornerUpLeft className="w-3.5 h-3.5 text-zinc-500" />
                          )}
                          <span className="text-xs text-zinc-400 truncate">
                            {replyMode === "reply-all" ? (
                              <>Tümüne yanıtla: <span className="text-zinc-300">{activeMail.sender.split('<')[0].replace(/"/g, '').trim()}{activeMail.cc ? `, ${activeMail.cc}` : ""}</span></>
                            ) : (
                              <>{tr.mail.replyTo} <span className="text-zinc-300">{activeMail.sender.split('<')[0].replace(/"/g, '').trim()}</span></>
                            )}
                          </span>
                        </div>
                        <textarea
                          ref={replyRef}
                          value={replyText}
                          onChange={(e) => setReplyText(e.target.value)}
                          placeholder={tr.mail.writeReply}
                          className="w-full bg-transparent p-4 text-sm text-zinc-200 placeholder:text-zinc-600 outline-none resize-none min-h-[120px] select-text"
                        />
                        <div className="px-3 py-2 border-t border-white/[0.04] text-[11px] text-zinc-700 italic truncate">
                          — {activeMail.sender.split('<')[0].replace(/"/g, '').trim()}, {formatDateFull(activeMail.date)}
                        </div>
                        <div className="px-4 py-2.5 border-t border-white/5 flex items-center justify-between">
                          <button
                            onClick={() => { setShowReply(false); setReplyText(""); }}
                            className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
                          >
                            {tr.mail.cancel}
                          </button>
                          <button
                            onClick={handleReply}
                            disabled={!replyText.trim() || isSending}
                            className="px-4 py-1.5 bg-blue-500 hover:bg-blue-600 disabled:opacity-40 disabled:hover:bg-blue-500 text-white text-xs font-medium rounded-md transition-colors flex items-center gap-2"
                          >
                            {isSending ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                            {isSending ? tr.compose.sending : tr.mail.sendReply}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </main>
            ) : (
              <main className={`${mailViewMode === "split" ? "hidden md:flex" : "hidden"} flex-1 items-center justify-center bg-[#0a0a0c]`}>
                <div className="text-center">
                  <div className="w-14 h-14 rounded-2xl bg-white/[0.03] flex items-center justify-center mx-auto mb-3">
                    <Inbox className="w-7 h-7 text-zinc-700" />
                  </div>
                  <h3 className="text-zinc-500 font-medium text-sm">{tr.mail.noSelection}</h3>
                  <p className="text-xs text-zinc-700 mt-1">{tr.mail.noSelectionHint}</p>
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
            {AUTH_RELOGIN_MESSAGE}
          </div>
          <button
            onClick={loginWithGoogle}
            className="px-3 py-1 bg-white text-red-600 text-xs font-semibold rounded hover:bg-red-50 transition-colors"
          >
            Giriş Yap
          </button>
        </div>
      )}

      {/* Confirm Modal */}
      {confirmModal && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setConfirmModal(null)}>
          <div
            className="w-full max-w-sm bg-[#111113] border border-white/10 rounded-xl shadow-2xl p-6 mx-4"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-start gap-3 mb-5">
              <div className="w-9 h-9 rounded-lg bg-red-500/15 flex items-center justify-center shrink-0">
                <AlertTriangle className="w-4.5 h-4.5 text-red-400" />
              </div>
              <p className="text-sm text-zinc-200 leading-relaxed">{confirmModal.message}</p>
            </div>
            <div className="flex items-center justify-end gap-3">
              <button
                onClick={() => setConfirmModal(null)}
                className="px-4 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 rounded-lg hover:bg-white/5 transition-colors"
              >
                İptal
              </button>
              <button
                onClick={() => { confirmModal.onConfirm(); setConfirmModal(null); }}
                className="px-4 py-1.5 bg-red-600 hover:bg-red-700 text-white text-xs font-medium rounded-lg transition-colors"
              >
                Sil
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast notifications */}
      <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 pointer-events-none max-w-sm">
        {toasts.map(toast => (
          <div
            key={toast.id}
            className={`pointer-events-auto flex items-center gap-2 px-4 py-2.5 rounded-lg shadow-lg text-xs font-medium backdrop-blur-md animate-[slideIn_0.3s_ease] ${toast.type === 'error' ? 'bg-red-500/90 text-white' :
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
