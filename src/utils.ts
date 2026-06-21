import type { OtpMode, RenderMode, MailZoom, MailViewMode, AppControls } from "./types";
import { type ThemePresetName, themePresets } from "./theme";

export const LARGE_BODY_RENDER_LIMIT = 4_000_000;
export const MAX_INLINE_DATA_URI = 4_000_000;
export const FIXED_LAYOUT_MIN_WIDTH = 460;
export const IMAGE_PROXY_BASE = "http://mailimg.localhost/?url=";
export const MAX_LABEL_CACHE = 5;
export const STARTUP_NETWORK_DELAY_MS = 5000;
export const STARTUP_UPDATE_DELAY_MS = 9000;
export const MAIL_TABS = new Set(["inbox", "sent", "archive", "spam", "trash"]);
export const AUTH_RELOGIN_MESSAGE = "Oturum yenilenemedi. Lütfen tekrar giriş yapın.";
export const ZOOM_STEPS = [0.5, 0.6, 0.7, 0.8, 0.9, 1, 1.25, 1.5, 1.75, 2];
export const MIN_ZOOM = ZOOM_STEPS[0];
export const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1];

export function isNoUpdateError(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return /no update|not available|up to date|guncel|güncel|204/.test(message);
}

export function isAuthFailure(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return /401|unauthorized|invalid_grant|invalid credentials|unauthenticated|autherror|expected oauth 2 access token|no refresh token|oturum yenilenemedi|oturum bilgisi bulunamad/.test(message);
}

export function byteLength(text: string): number {
  return new Blob([text]).size;
}

export function decodeBasicHtmlEntities(html: string): string {
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

export function stripHtml(html: string): string {
  const decoded = decodeBasicHtmlEntities(html);
  return decoded
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function escapeHtml(text: string): string {
  return decodeBasicHtmlEntities(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function sanitizeEmailHtml(html: string, fallback: string): string {
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

export function proxifyEmailImages(html: string): string {
  return html
    .replace(
      /(<img\b[^>]*?\ssrc\s*=\s*)(["'])(https?:\/\/[^"']+)\2/gi,
      (_match, prefix, quote, url) => `${prefix}${quote}${IMAGE_PROXY_BASE}${encodeURIComponent(url)}${quote}`
    )
    .replace(/\ssrcset\s*=\s*("[^"]*"|'[^']*')/gi, "")
    .replace(/\sloading\s*=\s*["']lazy["']/gi, "");
}

export function buildRenderableEmailHtml(html: string, fallback: string, mode: RenderMode): string {
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

export function normalizeOtpPlaintext(text: string): string {
  // Remove zero-width and invisible unicode characters
  let s = text.replace(/[​-‍﻿⁠­]/g, "");
  s = s.replace(/\s+/g, " ").trim();
  // Join digits split by spaces: "1 2 3 4 5 6" → "123456"
  s = s.replace(/\b(?:\d[\s ]){3,11}\d\b/g, (m) => m.replace(/[\s ]+/g, ""));
  // Join hyphenated digit groups: "123-456" → "123456" (only for 3-4 digit groups totaling 4-8)
  s = s.replace(/\b(\d{3,4})[\s-](\d{3,4})\b/g, (m, g1, g2) => {
    if (g1.length + g2.length >= 4 && g1.length + g2.length <= 8) return g1 + g2;
    return m;
  });
  return s;
}

// Email must contain at least one of these signals to be considered an OTP email
const OTP_SIGNAL_RE =
  /\b(?:verif(?:y|ication|ied)|doğrula(?:ma|yın|n|mak|r)?|dogrula(?:ma|yin|n|mak|r)?|onayla(?:yın|n|mak)?|confirm(?:ation)?|onay\s*kodu?|otp|one[\s-]?time|tek[\s-]?kullan|2fa|mfa|güvenlik\s*kodu?|guvenlik\s*kodu?|sms\s*kodu?|authentication\s*code|security\s*code|login\s*code|sign[\s-]?in\s*code|access\s*code|hesap\s*doğrulama)\b/i;

// Context words that suggest a number is NOT an OTP
const FALSE_POS_RE =
  /\b(?:order\s*#?|sipariş|fatura|invoice|ticket\s*#?|case\s*#?|ref(?:erence)?\s*#?|tracking|takip\s*no|po\s+box|sokak|cadde|mahalle|bulvar|version\s+v?\d|\biso\b|\bvat\b|\bkdv\b)\b/i;

const METRIC_SUFFIX_RE = /^\d+(?:\.\d+)?[kmb]$/i;

function isValidCode(code: string): boolean {
  if (METRIC_SUFFIX_RE.test(code)) return false;
  if (/^[A-Za-z]+$/.test(code)) return false; // all letters = promo slug, not OTP
  if (/^\d+$/.test(code)) {
    if (/^(?:19|20)\d{2}$/.test(code)) return false; // year
    if (/^(?:27001|27701|22301|9001|42001|14001|45001|50001|31000)$/.test(code)) return false; // ISO standards
  }
  return true;
}

function falsePositiveNearby(text: string, idx: number, len: number): boolean {
  const before = text.slice(Math.max(0, idx - 80), idx);
  const after = text.slice(idx + len, Math.min(text.length, idx + len + 80));
  if (/[$€₺\xA3\xA5]\s*$/.test(before.trimEnd())) return true; // currency before
  if (/^\s*%/.test(after)) return true; // percentage after
  return FALSE_POS_RE.test(before + " " + after);
}

// Tier 1: Service-prefixed codes — "G-123456", "FB-654321"
function matchPrefixed(text: string): string | null {
  const re = /\b[A-Z]{1,3}-(\d{4,8})\b/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const ctx = text.slice(Math.max(0, m.index - 100), m.index + m[0].length + 100);
    if (/\bis\s+your\b|\bverif|\bdoğrulama|\bkodunuz\b|\bonay\b/i.test(ctx)) return m[1];
  }
  return null;
}

// Tier 2: Bracket codes — "[123456]" or "(654321)" — most reliable in subject lines
function matchBracket(text: string): string | null {
  const re = /[\[(](\d{4,8})[\])]/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (isValidCode(m[1])) return m[1];
  }
  return null;
}

// Tier 3: keyword immediately before code — "code: 123456", "doğrulama kodunuz: 123456", "OTP: 123456"
const KW_BEFORE_CODE_RE =
  /(?:(?:verification|security|login|confirmation|access|one[\s-]?time|sms|güvenlik|guvenlik|doğrulama|dogrulama|onay)[\s-])?(?:code|kod(?:unuz|unu|u|lar)?|kodu|otp|pin|şifre(?:niz|nizi)?|sifre(?:niz|nizi)?|passcode|parola(?:nız|nızı)?)\s*(?:is\s+)?[:\-=→>]{1,2}\s*([A-Z0-9]{4,10})\b/gi;

function matchKeywordBefore(text: string): string | null {
  KW_BEFORE_CODE_RE.lastIndex = 0;
  let m;
  while ((m = KW_BEFORE_CODE_RE.exec(text)) !== null) {
    const code = m[1];
    if (isValidCode(code) && !falsePositiveNearby(text, m.index, m[0].length)) return code;
  }
  return null;
}

// Tier 4: code-first sentences — "123456 is your WhatsApp code", "654321 kodunuz"
const CODE_FIRST_RE = /\b([A-Z0-9]{4,8})\s+(?:is\s+(?:your|the)\b|kodunuz\b|şifreniz\b|sifreniz\b)/gi;

function matchCodeFirst(text: string): string | null {
  CODE_FIRST_RE.lastIndex = 0;
  let m;
  while ((m = CODE_FIRST_RE.exec(text)) !== null) {
    const code = m[1];
    if (!isValidCode(code) || falsePositiveNearby(text, m.index, m[0].length)) continue;
    // Turkish possessive forms already imply OTP context
    if (/kodunuz|şifreniz|sifreniz/i.test(m[0])) return code;
    // For "is your X", require an OTP word somewhere nearby
    const ctx = text.slice(Math.max(0, m.index - 30), m.index + m[0].length + 80);
    if (/\b(?:code|kod|otp|pin|verif|doğrulama|auth|login|password|şifre|sifre|confirm|onay)\b/i.test(ctx))
      return code;
  }
  return null;
}

// Tier 5: imperative patterns — "enter 123456", "use code 654321", "girin: 123456"
// Also handles Turkish "bu kodu kullanın: 123456" and "bu kodu girin: 123456" (Google emails)
const ENTER_RE = /\b(?:enter|use|input|type|girin?|kullanın?|giriniz)\s*:?\s+(?:the\s+)?(?:code\s+)?([A-Z0-9]{4,10})\b/gi;
const KODU_KULLAN_RE = /\b(?:bu\s+)?(?:kod(?:unuz|u|unu)?)\s+(?:kullanın?|girin?|giriniz)\s*[:\-]?\s*([A-Z0-9]{4,10})\b/gi;

function matchEnter(text: string): string | null {
  ENTER_RE.lastIndex = 0;
  let m;
  while ((m = ENTER_RE.exec(text)) !== null) {
    const code = m[1];
    if (isValidCode(code) && !falsePositiveNearby(text, m.index, m[0].length)) return code;
  }
  KODU_KULLAN_RE.lastIndex = 0;
  while ((m = KODU_KULLAN_RE.exec(text)) !== null) {
    const code = m[1];
    if (isValidCode(code) && !falsePositiveNearby(text, m.index, m[0].length)) return code;
  }
  return null;
}

// Tier 6: most prominent 6-digit number in a confirmed OTP email (last resort)
function matchFallback(subject: string, snippet: string, body: string, mode: OtpMode): string | null {
  type Candidate = { code: string; priority: number };
  const seen = new Set<string>();
  const candidates: Candidate[] = [];
  const SIX = /\b(\d{6})\b/g;

  const addFrom = (text: string, priority: number) => {
    SIX.lastIndex = 0;
    let m;
    while ((m = SIX.exec(text)) !== null) {
      const code = m[1];
      if (seen.has(code) || !isValidCode(code) || falsePositiveNearby(text, m.index, 6)) continue;
      seen.add(code);
      candidates.push({ code, priority });
    }
  };

  addFrom(subject, 3);
  addFrom(snippet, 2);
  addFrom(body.slice(0, 800), 1); // OTP codes appear near the top of the email body

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.priority - a.priority);
  // Strict mode only accepts codes found in the subject line
  if (mode === "strict" && candidates[0].priority < 3) return null;
  return candidates[0].code;
}

export function extractVerificationCode(
  email: { subject: string; snippet: string; body_html: string },
  mode: OtpMode = "balanced"
): string | null {
  if (mode === "off") return null;

  const subject = normalizeOtpPlaintext(email.subject || "");
  const body = normalizeOtpPlaintext(stripHtml(email.body_html || ""));
  const snippet = normalizeOtpPlaintext(email.snippet || "");
  const full = `${subject} ${snippet} ${body}`;

  const isOtpEmail = OTP_SIGNAL_RE.test(full);

  if (!isOtpEmail) {
    // Doesn't look like an OTP email: only check subject for very obvious matches
    if (mode === "strict") return null;
    return (
      matchPrefixed(subject) ??
      matchBracket(subject) ??
      matchKeywordBefore(subject) ??
      matchCodeFirst(subject) ??
      null
    );
  }

  // Bracket in subject is the most reliable signal — check it first
  const bracket = matchBracket(subject);
  if (bracket) return bracket;

  // Tiered search: each tier tries subject → snippet → body
  const tiers = [matchPrefixed, matchKeywordBefore, matchCodeFirst, matchEnter];
  for (const fn of tiers) {
    const result = fn(subject) ?? fn(snippet) ?? fn(body);
    if (result) return result;
  }

  // Last resort: most prominent 6-digit number in a confirmed OTP email
  return matchFallback(subject, snippet, body, mode);
}

export function resolveEmailUrl(url: string | null | undefined): string | null {
  if (!url || url.startsWith("#")) return null;
  try {
    const resolved = new URL(url, "https://mail.google.com/").href;
    return /^(https?:|mailto:|tel:)/i.test(resolved) ? resolved : null;
  } catch {
    return null;
  }
}

export function findEmailUrl(eventTarget: EventTarget | null): string | null {
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

export function buildEmailSrcDoc(html: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"/>
    <style>
      html, body { margin: 0; padding: 0; background: #fff; overflow: hidden; }
      * { box-sizing: border-box; }
      .mail-root {
        display: block; width: 100%; min-width: 0; padding: 0;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
        font-size: 15px; line-height: 1.6; color: #1a1a1a;
      }
      .mail-root > .plain-text { padding: 20px 24px; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; max-width: 720px; }
      img, video { height: auto; }
      a { color: #2563eb; }
      ::selection { background: rgba(59, 130, 246, 0.25); }
    </style></head>
    <body><div class="mail-root">${html}</div></body></html>`;
}

export function readMailZoom(): MailZoom {
  const saved = localStorage.getItem("fursoy_mail_zoom");
  if (!saved || saved === "fit") return "fit";
  const value = parseFloat(saved);
  return Number.isFinite(value) ? Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, value)) : "fit";
}

export function getAutoMailViewMode(width: number): MailViewMode {
  if (width < 900) return "inbox-first";
  return "split";
}

export function readThemePreset(): ThemePresetName {
  const saved = localStorage.getItem("fursoy_theme_preset");
  return saved && saved in themePresets ? (saved as ThemePresetName) : "blue";
}

export function minutesFromTime(value: string): number {
  const [hours, minutes] = value.split(":").map(part => parseInt(part, 10));
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return 0;
  return Math.max(0, Math.min(23, hours)) * 60 + Math.max(0, Math.min(59, minutes));
}

export function isInQuietHours(controls: AppControls): boolean {
  if (!controls.quietHoursEnabled) return false;
  const now = new Date();
  const current = now.getHours() * 60 + now.getMinutes();
  const start = minutesFromTime(controls.quietHoursStart);
  const end = minutesFromTime(controls.quietHoursEnd);
  if (start === end) return true;
  if (start < end) return current >= start && current < end;
  return current >= start || current < end;
}

export function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();
  if (isToday) {
    return date.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString("tr-TR", { month: "short", day: "numeric" });
}

export function formatDateFull(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleDateString("tr-TR", {
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
