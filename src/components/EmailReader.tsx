import { useRef, useState, useEffect, type CSSProperties } from "react";
import {
  CornerUpLeft, Inbox, Send, Archive, ShieldAlert, Trash2,
  Users, Forward, Eye, RotateCcw, Minus, Plus, Maximize2,
  Settings, X, RefreshCw, Copy, ChevronDown, ChevronUp,
  Download, FileText, Image, File, Type, Link2, List, ListOrdered, Paperclip, Undo2, Redo2,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { tr } from "../i18n";
import type { EmailSummary, MailViewMode, MailZoom, RenderMode, AttachmentPayload } from "../types";

interface AttachmentInfo {
  id: string;
  filename: string;
  mime_type: string;
  size: number;
  attachment_id: string | null;
  data: string | null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function AttachmentIcon({ mimeType }: { mimeType: string }) {
  if (mimeType.startsWith("image/")) return <Image className="w-3.5 h-3.5" />;
  if (mimeType === "application/pdf" || mimeType.startsWith("text/")) return <FileText className="w-3.5 h-3.5" />;
  return <File className="w-3.5 h-3.5" />;
}
import { formatDateFull, buildRenderableEmailHtml } from "../utils";
import { EmailHtmlView } from "./EmailHtmlView";
import { ToolbarTip } from "./ToolbarTip";

// ── Thread card — one email in the conversation stack ──────────────────────────
function ThreadCard({
  email,
  isActive,
  preloadedHtml,
  isBodyLoading,
  hasLoadedBody,
  bodyError,
  defaultExpanded,
  renderMode,
  mailZoom,
  relayoutKey,
  onFitScaleChange,
  onOpenUrl,
  scrollRef,
}: {
  email: EmailSummary;
  isActive: boolean;
  preloadedHtml?: string;
  isBodyLoading?: boolean;
  hasLoadedBody?: boolean;
  bodyError?: string | null;
  defaultExpanded: boolean;
  renderMode: RenderMode;
  mailZoom: MailZoom;
  relayoutKey?: string;
  onFitScaleChange?: (scale: number) => void;
  onOpenUrl: (url: string) => void;
  scrollRef: React.RefObject<HTMLElement | null>;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [lazyBody, setLazyBody] = useState<string | null>(null);
  const [lazyLoading, setLazyLoading] = useState(false);

  const senderName = email.sender.split("<")[0].replace(/"/g, "").trim() || email.sender;
  const recipientDisplay = email.recipient
    ? email.recipient.split(",").map(r => r.split("<")[0].replace(/"/g, "").trim() || r.trim()).join(", ")
    : "me";

  const toggle = async () => {
    if (!expanded && !isActive && lazyBody === null && !lazyLoading) {
      setLazyLoading(true);
      try {
        const raw = await invoke<string>("get_email_body", { id: email.id });
        setLazyBody(buildRenderableEmailHtml(raw || "", email.snippet, renderMode));
      } catch {
        setLazyBody("");
      } finally {
        setLazyLoading(false);
      }
    }
    setExpanded(e => !e);
  };

  const bodyHtml = isActive ? preloadedHtml ?? "" : lazyBody ?? "";
  const loading = isActive ? (isBodyLoading ?? false) : lazyLoading;
  const loaded = isActive ? (hasLoadedBody ?? false) : lazyBody !== null;
  const error = isActive ? bodyError : null;

  return (
    <div className={`rounded-xl overflow-hidden border ${isActive ? "border-white/[0.10]" : "border-white/[0.06]"}`}>
      {/* Header — always visible, click to expand/collapse */}
      <button
        type="button"
        onClick={toggle}
        className={`w-full flex items-center gap-3 px-4 py-3 text-left transition-colors ${
          expanded ? "hover:bg-white/[0.02]" : "hover:bg-white/[0.02]"
        }`}
      >
        <div className="w-8 h-8 rounded-full bg-[var(--app-accent)] flex items-center justify-center text-white text-xs font-bold shrink-0">
          {(senderName[0] || "?").toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline justify-between gap-2">
            <span className={`truncate text-sm font-medium ${isActive ? "text-zinc-100" : "text-zinc-300"}`}>
              {senderName}
            </span>
            <span className="text-[11px] text-zinc-500 shrink-0">{formatDateFull(email.date)}</span>
          </div>
          {expanded ? (
            <div className="text-[11px] text-zinc-600 mt-0.5 truncate">
              <span className="text-zinc-700">to:</span> {recipientDisplay}
              {email.cc && <> · <span className="text-zinc-700">cc:</span> {email.cc}</>}
            </div>
          ) : (
            <p className="text-[11px] text-zinc-600 truncate mt-0.5">{email.snippet}</p>
          )}
        </div>
        {lazyLoading
          ? <RefreshCw className="w-3.5 h-3.5 text-zinc-600 animate-spin shrink-0" />
          : expanded
            ? <ChevronUp className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
            : <ChevronDown className="w-3.5 h-3.5 text-zinc-600 shrink-0" />
        }
      </button>

      {/* Body — shown when expanded */}
      {expanded && (
        <div className="border-t border-white/[0.05]">
          {loading ? (
            <div className="bg-white flex min-h-[200px] items-center justify-center text-xs text-zinc-400">
              {tr.mail.loadingBody}
            </div>
          ) : error ? (
            <div className="bg-white flex min-h-[200px] items-center justify-center text-xs text-red-400">
              {error}
            </div>
          ) : loaded ? (
            <div className="bg-white overflow-hidden">
              <EmailHtmlView
                key={email.id}
                html={bodyHtml}
                zoom={mailZoom}
                relayoutKey={relayoutKey}
                onFitScaleChange={onFitScaleChange ?? (() => {})}
                onOpenUrl={onOpenUrl}
                scrollRef={scrollRef}
              />
            </div>
          ) : (
            <div className="bg-white flex min-h-[200px] items-center justify-center text-xs text-zinc-400">
              {tr.mail.preparingBody}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── EmailReader props ──────────────────────────────────────────────────────────
interface EmailReaderProps {
  className: string;
  activeMail: EmailSummary;
  activeMailHtml: string;
  isBodyLoading: boolean;
  bodyError: string | null;
  hasLoadedActiveBody: boolean;
  mailViewMode: MailViewMode;
  activeTab: string;
  closeReader: () => void;

  showReply: boolean;
  setShowReply: (v: boolean) => void;
  replyMode: "reply" | "reply-all";
  setReplyMode: (v: "reply" | "reply-all") => void;
  replyText: string;
  setReplyText: (v: string) => void;
  isSending: boolean;
  onSendReply: (attachments: AttachmentPayload[], body: string) => void;

  mailZoom: MailZoom;
  setMailFitScale: (scale: number) => void;
  stepMailZoom: (dir: 1 | -1) => void;
  persistMailZoom: (zoom: MailZoom) => void;
  effectiveZoomPct: number;

  readingToolsOpen: boolean;
  setReadingToolsOpen: (v: boolean | ((prev: boolean) => boolean)) => void;
  renderMode: RenderMode;
  setRenderMode: (v: RenderMode) => void;

  verificationCode: string | null;
  verificationCopyState: "idle" | "copied";
  setVerificationCopyState: (v: "idle" | "copied") => void;

  showArchiveBtn: boolean;
  showRestoreBtn: boolean;
  showTrashToBinBtn: boolean;
  showDeleteForeverBtn: boolean;

  onArchive: () => void;
  onTrash: () => void;
  onMoveToInbox: () => void;
  onPermanentDelete: () => void;
  onMarkAsUnread: () => void;
  onForward: () => void;
  onOpenUrl: (url: string) => void;
  mailScrollRef: React.RefObject<HTMLDivElement | null>;
  relayoutKey: string;
  threadEmails: EmailSummary[];
  accessToken: string | null;
  showToast: (msg: string, kind: "success" | "error" | "info") => void;
}

// ── Main component ─────────────────────────────────────────────────────────────
export function EmailReader({
  className, activeMail, activeMailHtml,
  isBodyLoading, bodyError, hasLoadedActiveBody,
  mailViewMode, activeTab, closeReader,
  showReply, setShowReply, replyMode, setReplyMode, replyText, setReplyText,
  isSending, onSendReply,
  mailZoom, setMailFitScale, stepMailZoom, persistMailZoom, effectiveZoomPct,
  readingToolsOpen, setReadingToolsOpen, renderMode, setRenderMode,
  verificationCode, verificationCopyState, setVerificationCopyState,
  showArchiveBtn, showRestoreBtn, showTrashToBinBtn, showDeleteForeverBtn,
  onArchive, onTrash, onMoveToInbox, onPermanentDelete, onMarkAsUnread, onForward,
  onOpenUrl, mailScrollRef, relayoutKey, threadEmails, accessToken, showToast,
}: EmailReaderProps) {
  const replyEditableRef = useRef<HTMLDivElement>(null);
  const replyFileInputRef = useRef<HTMLInputElement>(null);
  const [replyEmpty, setReplyEmpty] = useState(true);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [showFormatBar, setShowFormatBar] = useState(false);
  const [linkPopover, setLinkPopover] = useState(false);
  const [linkText, setLinkText] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const savedRangeRef = useRef<Range | null>(null);
  const [replyAttachments, setReplyAttachments] = useState<(AttachmentPayload & { size: number })[]>([]);
  const [replyAttachError, setReplyAttachError] = useState<string | null>(null);

  const [attachments, setAttachments] = useState<AttachmentInfo[]>([]);
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  useEffect(() => {
    setAttachments([]);
    setThumbnails({});
    invoke<AttachmentInfo[]>("get_email_attachments", { emailId: activeMail.id })
      .then(atts => {
        setAttachments(atts);
        if (!accessToken) return;
        // Fetch thumbnails for image attachments that don't have inline data
        const imageAtts = atts.filter(a => a.mime_type.startsWith("image/") && !a.data);
        if (imageAtts.length === 0) return;
        const emailId = activeMail.id;
        const token = accessToken;
        Promise.allSettled(
          imageAtts.map(a =>
            invoke<string>("fetch_attachment_data", {
              emailId,
              attachmentDbId: a.id,
              accessToken: token,
            }).then(data => ({ id: a.id, data }))
          )
        ).then(results => {
          const map: Record<string, string> = {};
          for (const r of results) {
            if (r.status === "fulfilled") map[r.value.id] = r.value.data;
          }
          if (Object.keys(map).length > 0) setThumbnails(map);
        });
      })
      .catch(() => {});
  }, [activeMail.id, accessToken]);

  const handleDownload = async (att: AttachmentInfo) => {
    if (!accessToken) return;
    setDownloadingId(att.id);
    try {
      const savedName = await invoke<string>("save_and_reveal_attachment", {
        emailId: activeMail.id,
        attachmentDbId: att.id,
        accessToken,
      });
      showToast(`${savedName} İndirilenlere kaydedildi`, "success");
    } catch (e) {
      showToast("İndirme başarısız", "error");
      console.error("Download failed:", e);
    } finally {
      setDownloadingId(null);
    }
  };

  // Clear contenteditable when reply is hidden or replyText is reset by parent
  useEffect(() => {
    if (!showReply) {
      setShowFormatBar(false);
      setLinkPopover(false);
      setReplyEmpty(true);
      setReplyAttachments([]);
      setReplyAttachError(null);
      if (replyEditableRef.current) replyEditableRef.current.innerHTML = "";
    }
  }, [showReply]);

  useEffect(() => {
    if (replyText === "" && replyEditableRef.current) {
      replyEditableRef.current.innerHTML = "";
      setReplyEmpty(true);
    }
  }, [replyText]);

  const syncUndoRedo = () => {
    setCanUndo(document.queryCommandEnabled("undo"));
    setCanRedo(document.queryCommandEnabled("redo"));
  };

  const applyFormat = (command: string, value?: string) => {
    replyEditableRef.current?.focus();
    document.execCommand(command, false, value);
    setReplyEmpty(!(replyEditableRef.current?.innerText.trim()));
    syncUndoRedo();
  };

  const saveSelection = () => {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) {
      savedRangeRef.current = sel.getRangeAt(0).cloneRange();
      setLinkText(sel.toString());
    }
  };

  const restoreSelection = () => {
    const sel = window.getSelection();
    if (sel && savedRangeRef.current) {
      sel.removeAllRanges();
      sel.addRange(savedRangeRef.current);
    }
  };

  const applyLink = () => {
    if (!linkUrl) return;
    restoreSelection();
    replyEditableRef.current?.focus();
    if (linkText && !window.getSelection()?.toString()) {
      document.execCommand("insertHTML", false, `<a href="${linkUrl}">${linkText}</a>`);
    } else {
      document.execCommand("createLink", false, linkUrl);
    }
    setReplyEmpty(!(replyEditableRef.current?.innerText.trim()));
    setLinkPopover(false);
    setLinkText("");
    setLinkUrl("");
  };

  const BLOCKED_EXT = new Set(["exe","bat","cmd","com","msi","scr","pif","vbs","vbe","js","jse","jar","wsf","wsh","ps1","reg","inf","lnk"]);
  const MAX_ATT_BYTES = 20 * 1024 * 1024;

  const handleReplyFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (!files.length) return;
    setReplyAttachError(null);
    const blocked = files.filter(f => BLOCKED_EXT.has(f.name.split(".").pop()?.toLowerCase() ?? ""));
    if (blocked.length) { setReplyAttachError(`Engellenen tür: ${blocked.map(f => f.name).join(", ")}`); return; }
    const existingBytes = replyAttachments.reduce((s, a) => s + a.size, 0);
    const newBytes = files.reduce((s, f) => s + f.size, 0);
    if (existingBytes + newBytes > MAX_ATT_BYTES) {
      setReplyAttachError(`Toplam ek boyutu 20 MB'ı geçemez.`); return;
    }
    files.forEach(file => {
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = (reader.result as string).split(",")[1];
        setReplyAttachments(prev => [...prev, { filename: file.name, mimeType: file.type || "application/octet-stream", data: base64, size: file.size }]);
      };
      reader.readAsDataURL(file);
    });
  };

  // All emails to render: full thread if available, otherwise just activeMail
  const allEmails = threadEmails.length > 0 ? threadEmails : [activeMail];

  const openReply = (mode: "reply" | "reply-all") => {
    setReplyMode(mode);
    setShowReply(true);
    setTimeout(() => replyEditableRef.current?.focus(), 100);
  };

  return (
    <main className={className}>
      {/* Mobile Back Button */}
      <div className="md:hidden h-12 flex items-center px-4 border-b border-white/5 shrink-0">
        <button
          onClick={closeReader}
          className="flex items-center gap-2 text-xs text-zinc-400 hover:text-zinc-200"
        >
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
            >
              <CornerUpLeft className="h-3.5 w-3.5" />
            </button>
          )}
          <span className="min-w-0 truncate text-xs text-zinc-500 flex items-center gap-1.5 capitalize">
            {activeTab === "inbox" && <Inbox className="w-3.5 h-3.5 shrink-0" />}
            {activeTab === "sent" && <Send className="w-3.5 h-3.5 shrink-0" />}
            {activeTab === "archive" && <Archive className="w-3.5 h-3.5 shrink-0" />}
            {activeTab === "spam" && <ShieldAlert className="w-3.5 h-3.5 shrink-0" />}
            {activeTab === "trash" && <Trash2 className="w-3.5 h-3.5 shrink-0" />}
            <span className="truncate">{activeMail.subject}</span>
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-0.5" style={{ WebkitAppRegion: "no-drag" } as CSSProperties}>
          <ToolbarTip label="Yanıtla">
            <button
              type="button"
              onClick={() => openReply("reply")}
              className={`p-2 rounded-md hover:bg-white/5 transition-colors ${
                showReply && replyMode === "reply" ? "text-blue-400 bg-blue-500/10" : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              <CornerUpLeft className="w-4 h-4" />
            </button>
          </ToolbarTip>
          <ToolbarTip label="Tümünü yanıtla">
            <button
              type="button"
              onClick={() => openReply("reply-all")}
              className={`p-2 rounded-md hover:bg-white/5 transition-colors ${
                showReply && replyMode === "reply-all" ? "text-blue-400 bg-blue-500/10" : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              <Users className="w-4 h-4" />
            </button>
          </ToolbarTip>
          <ToolbarTip label="İlet">
            <button type="button" onClick={onForward} className="p-2 rounded-md hover:bg-white/5 text-zinc-400 hover:text-zinc-200 transition-colors">
              <Forward className="w-4 h-4" />
            </button>
          </ToolbarTip>
          <ToolbarTip label="Okunmadı olarak işaretle">
            <button type="button" onClick={onMarkAsUnread} className="p-2 rounded-md hover:bg-white/5 text-zinc-400 hover:text-zinc-200 transition-colors">
              <Eye className="w-4 h-4" />
            </button>
          </ToolbarTip>
          {showRestoreBtn && (
            <ToolbarTip label={activeTab === "spam" ? "Spam değil (gelen kutusu)" : "Gelen kutusuna taşı"}>
              <button type="button" onClick={onMoveToInbox} className="p-2 rounded-md hover:bg-white/5 text-zinc-400 hover:text-emerald-400 transition-colors">
                <RotateCcw className="w-4 h-4" />
              </button>
            </ToolbarTip>
          )}
          {showArchiveBtn && (
            <ToolbarTip label="Arşivle">
              <button type="button" onClick={onArchive} className="p-2 rounded-md hover:bg-white/5 text-zinc-400 hover:text-amber-400 transition-colors">
                <Archive className="w-4 h-4" />
              </button>
            </ToolbarTip>
          )}
          {showTrashToBinBtn && (
            <ToolbarTip label="Çöpe taşı">
              <button type="button" onClick={onTrash} className="p-2 rounded-md hover:bg-white/5 text-zinc-400 hover:text-red-400 transition-colors">
                <Trash2 className="w-4 h-4" />
              </button>
            </ToolbarTip>
          )}
          {showDeleteForeverBtn && (
            <ToolbarTip label="Kalıcı olarak sil">
              <button type="button" onClick={onPermanentDelete} className="p-2 rounded-md hover:bg-white/5 text-zinc-400 hover:text-red-500 transition-colors">
                <Trash2 className="w-4 h-4" />
              </button>
            </ToolbarTip>
          )}
          <div className="mx-1 hidden h-5 w-px bg-white/5 lg:block" />
          <div className="hidden items-center rounded-md border border-white/10 bg-white/[0.03] lg:flex">
            <ToolbarTip label={tr.reading.zoomOut}>
              <button type="button" onClick={() => stepMailZoom(-1)} className="flex h-7 w-7 items-center justify-center rounded-l-md text-zinc-400 hover:bg-white/5 hover:text-zinc-100">
                <Minus className="h-3.5 w-3.5" />
              </button>
            </ToolbarTip>
            <ToolbarTip label={tr.reading.fitWidthHint}>
              <button
                type="button"
                onClick={() => persistMailZoom("fit")}
                className={`flex h-7 min-w-[3.25rem] items-center justify-center gap-1 px-1 text-[11px] font-medium tabular-nums transition-colors ${
                  mailZoom === "fit" ? "text-[var(--app-accent)]" : "text-zinc-300 hover:text-zinc-100"
                }`}
              >
                {mailZoom === "fit" && <Maximize2 className="h-3 w-3" />}
                {effectiveZoomPct}%
              </button>
            </ToolbarTip>
            <ToolbarTip label={tr.reading.zoomIn}>
              <button type="button" onClick={() => stepMailZoom(1)} className="flex h-7 w-7 items-center justify-center rounded-r-md text-zinc-400 hover:bg-white/5 hover:text-zinc-100">
                <Plus className="h-3.5 w-3.5" />
              </button>
            </ToolbarTip>
          </div>
          <ToolbarTip label={tr.reading.settings}>
            <button
              type="button"
              onClick={() => setReadingToolsOpen(open => !open)}
              className={`p-2 rounded-md transition-colors ${
                readingToolsOpen ? "bg-[var(--app-accent-soft)] text-zinc-100" : "text-zinc-400 hover:bg-white/5 hover:text-zinc-200"
              }`}
            >
              <Settings className="w-4 h-4" />
            </button>
          </ToolbarTip>
        </div>
      </div>

      {/* Reading Tools Panel */}
      <aside
        className={`absolute bottom-0 right-0 top-12 z-20 hidden w-72 border-l border-white/10 bg-[#0c0c0e]/95 p-4 shadow-2xl shadow-black/30 backdrop-blur-xl transition-transform duration-200 md:block ${
          readingToolsOpen ? "translate-x-0" : "translate-x-full"
        }`}
        aria-hidden={!readingToolsOpen}
      >
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-zinc-200">{tr.reading.settings}</h3>
          <button type="button" onClick={() => setReadingToolsOpen(false)} className="rounded-md p-1 text-zinc-500 hover:bg-white/10 hover:text-zinc-200">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-5">
          <div>
            <div className="mb-1 text-sm text-zinc-300">{tr.reading.zoom}</div>
            <p className="mb-2 text-[11px] leading-relaxed text-zinc-600">{tr.reading.zoomHint}</p>
            <div className="flex items-center gap-2">
              <div className="inline-flex items-center rounded-lg border border-white/10 bg-[#09090b]">
                <button type="button" onClick={() => stepMailZoom(-1)} className="flex h-8 w-8 items-center justify-center text-zinc-400 hover:text-zinc-100">
                  <Minus className="h-3.5 w-3.5" />
                </button>
                <span className="min-w-[3rem] text-center text-xs font-medium text-zinc-200 tabular-nums">{effectiveZoomPct}%</span>
                <button type="button" onClick={() => stepMailZoom(1)} className="flex h-8 w-8 items-center justify-center text-zinc-400 hover:text-zinc-100">
                  <Plus className="h-3.5 w-3.5" />
                </button>
              </div>
              <button
                type="button"
                onClick={() => persistMailZoom("fit")}
                className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs transition-colors ${
                  mailZoom === "fit" ? "border-[var(--app-accent)] bg-[var(--app-accent-soft)] text-zinc-100" : "border-white/10 bg-[#09090b] text-zinc-400 hover:text-zinc-200"
                }`}
              >
                <Maximize2 className="h-3.5 w-3.5" />
                {tr.reading.fitWidth}
              </button>
            </div>
          </div>
          <div>
            <div className="mb-2 text-xs font-medium text-zinc-300">{tr.reading.renderMode}</div>
            <div className="inline-flex rounded-lg border border-white/10 bg-[#09090b] p-1">
              {(["full", "simple"] as const).map(mode => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => { setRenderMode(mode); localStorage.setItem("fursoy_render_mode", mode); }}
                  className={`px-3 py-1.5 text-xs rounded-md transition-colors ${renderMode === mode ? "bg-white/10 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"}`}
                >
                  {mode === "full" ? "Tam HTML" : "Basit"}
                </button>
              ))}
            </div>
          </div>
        </div>
      </aside>

      {/* Scrollable Content */}
      <div ref={mailScrollRef} className="flex-1 overflow-y-scroll overscroll-contain p-6 md:p-8">
        <div className="mx-auto w-full max-w-[1040px] min-w-0">

          {/* Subject heading */}
          <h1 className="text-xl font-bold text-zinc-100 mb-5 leading-snug">{activeMail.subject}</h1>

          {/* Received email attachments */}
          {attachments.length > 0 && (
            <div className="mb-4 flex flex-wrap gap-2">
              {attachments.map(att => {
                const isImage = att.mime_type.startsWith("image/");
                const thumbData = att.data ?? thumbnails[att.id] ?? null;
                const hasThumb = isImage && thumbData;
                return (
                  <button
                    key={att.id}
                    type="button"
                    onClick={() => handleDownload(att)}
                    disabled={downloadingId === att.id}
                    className="flex flex-col rounded-lg bg-white/[0.04] border border-white/[0.08] hover:bg-white/[0.07] hover:border-white/[0.14] transition-colors text-left disabled:opacity-50 overflow-hidden"
                    style={{ maxWidth: 200 }}
                  >
                    {hasThumb && (
                      <img
                        src={`data:${att.mime_type};base64,${thumbData}`}
                        alt=""
                        className="w-full object-cover"
                        style={{ maxHeight: 160 }}
                      />
                    )}
                    <div className="flex items-center gap-2 px-3 py-2">
                      <span className="text-zinc-400 shrink-0">
                        <AttachmentIcon mimeType={att.mime_type} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="text-xs text-zinc-300 truncate">{att.filename}</div>
                        <div className="text-[10px] text-zinc-600">{formatBytes(att.size)}</div>
                      </div>
                      {downloadingId === att.id
                        ? <RefreshCw className="w-3.5 h-3.5 text-zinc-500 animate-spin shrink-0" />
                        : <Download className="w-3.5 h-3.5 text-zinc-600 shrink-0" />
                      }
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {/* OTP Banner */}
          {verificationCode && (
            <div className="mb-5 flex items-center justify-between px-4 py-3 rounded-lg bg-blue-500/10 border border-blue-500/20">
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

          {/* Thread stack — all emails chronologically, latest (activeMail) expanded */}
          <div className="space-y-2">
            {allEmails.map((email) => {
              const isActive = email.id === activeMail.id;
              return (
                <ThreadCard
                  key={email.id}
                  email={email}
                  isActive={isActive}
                  preloadedHtml={isActive ? activeMailHtml : undefined}
                  isBodyLoading={isActive ? isBodyLoading : undefined}
                  hasLoadedBody={isActive ? hasLoadedActiveBody : undefined}
                  bodyError={isActive ? bodyError : undefined}
                  defaultExpanded={isActive}
                  renderMode={renderMode}
                  mailZoom={mailZoom}
                  relayoutKey={isActive ? relayoutKey : undefined}
                  onFitScaleChange={isActive ? setMailFitScale : undefined}
                  onOpenUrl={onOpenUrl}
                  scrollRef={mailScrollRef as React.RefObject<HTMLElement | null>}
                />
              );
            })}
          </div>

          {/* Mobile action buttons */}
          <div className="flex md:hidden items-center gap-1 mt-4">
            <ToolbarTip label="Yanıtla">
              <button type="button" onClick={() => setShowReply(!showReply)} className="p-2 rounded-md hover:bg-white/5 text-zinc-400">
                <CornerUpLeft className="w-4 h-4" />
              </button>
            </ToolbarTip>
            {showRestoreBtn && (
              <ToolbarTip label={activeTab === "spam" ? "Spam değil" : "Gelen kutusu"}>
                <button type="button" onClick={onMoveToInbox} className="p-2 rounded-md hover:bg-white/5 text-zinc-400">
                  <RotateCcw className="w-4 h-4" />
                </button>
              </ToolbarTip>
            )}
            {showArchiveBtn && (
              <ToolbarTip label="Arşivle">
                <button type="button" onClick={onArchive} className="p-2 rounded-md hover:bg-white/5 text-zinc-400">
                  <Archive className="w-4 h-4" />
                </button>
              </ToolbarTip>
            )}
            {showTrashToBinBtn && (
              <ToolbarTip label="Çöpe taşı">
                <button type="button" onClick={onTrash} className="p-2 rounded-md hover:bg-white/5 text-zinc-400">
                  <Trash2 className="w-4 h-4" />
                </button>
              </ToolbarTip>
            )}
            {showDeleteForeverBtn && (
              <ToolbarTip label="Kalıcı sil">
                <button type="button" onClick={onPermanentDelete} className="p-2 rounded-md hover:bg-white/5 text-zinc-400">
                  <Trash2 className="w-4 h-4" />
                </button>
              </ToolbarTip>
            )}
          </div>

          {/* Reply Box */}
          {showReply && (
            <div className="mt-4 rounded-xl border border-white/10 bg-white/[0.02] overflow-hidden">
              {/* To: header */}
              <div className="px-4 py-2.5 border-b border-white/5 flex items-center gap-2">
                {replyMode === "reply-all"
                  ? <Users className="w-3.5 h-3.5 text-zinc-500" />
                  : <CornerUpLeft className="w-3.5 h-3.5 text-zinc-500" />
                }
                <span className="text-xs text-zinc-400 truncate">
                  {replyMode === "reply-all" ? (
                    <>Tümüne yanıtla: <span className="text-zinc-300">{activeMail.sender.split("<")[0].replace(/"/g, "").trim()}{activeMail.cc ? `, ${activeMail.cc}` : ""}</span></>
                  ) : (
                    <>{tr.mail.replyTo} <span className="text-zinc-300">{activeMail.sender.split("<")[0].replace(/"/g, "").trim()}</span></>
                  )}
                </span>
              </div>

              {/* Editable area */}
              <div className="relative px-4 pt-4 pb-3 min-h-[120px]">
                {replyEmpty && (
                  <span className="absolute top-4 left-4 pointer-events-none text-zinc-600 text-sm select-none">
                    {tr.mail.writeReply}
                  </span>
                )}
                <div
                  ref={replyEditableRef}
                  contentEditable
                  suppressContentEditableWarning
                  onInput={() => {
                    setReplyEmpty(!(replyEditableRef.current?.innerText.trim()));
                    syncUndoRedo();
                  }}
                  className="outline-none text-sm text-zinc-200 min-h-[96px] [&_a]:text-blue-400 [&_a]:underline [&_b]:font-bold [&_strong]:font-bold [&_i]:italic [&_em]:italic [&_u]:underline [&_s]:line-through [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5"
                  style={{ wordBreak: "break-word" }}
                />
              </div>

              {/* Quote attribution */}
              <div className="px-4 pb-2 text-[11px] text-zinc-700 italic truncate border-t border-white/[0.03] pt-2">
                — {activeMail.sender.split("<")[0].replace(/"/g, "").trim()}, {formatDateFull(activeMail.date)}
              </div>

              {/* Formatting toolbar — visible when showFormatBar */}
              {showFormatBar && (
                <div className="relative px-3 py-1.5 border-t border-white/[0.06] flex items-center gap-0.5">
                  {/* Link popover */}
                  {linkPopover && (
                    <div className="absolute bottom-full left-0 mb-1 bg-[#18181b] border border-white/10 rounded-xl p-3 shadow-2xl z-50 w-64">
                      <div className="flex flex-col gap-2">
                        <input
                          autoFocus
                          value={linkText}
                          onChange={e => setLinkText(e.target.value)}
                          placeholder="Metin"
                          className="w-full bg-white/[0.05] border border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-zinc-200 outline-none focus:border-blue-500/50 placeholder:text-zinc-600"
                        />
                        <input
                          value={linkUrl}
                          onChange={e => setLinkUrl(e.target.value)}
                          placeholder="https://..."
                          className="w-full bg-white/[0.05] border border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-zinc-200 outline-none focus:border-blue-500/50 placeholder:text-zinc-600"
                          onKeyDown={e => e.key === "Enter" && applyLink()}
                        />
                        <div className="flex gap-2 justify-end pt-0.5">
                          <button
                            type="button"
                            onClick={() => setLinkPopover(false)}
                            className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
                          >İptal</button>
                          <button
                            type="button"
                            onClick={applyLink}
                            disabled={!linkUrl}
                            className="px-3 py-1 bg-blue-500 hover:bg-blue-600 disabled:opacity-40 text-white text-xs rounded-md transition-colors"
                          >Uygula</button>
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Format buttons */}
                  <button type="button" title="Geri Al" disabled={!canUndo} onMouseDown={e => { e.preventDefault(); applyFormat("undo"); }}
                    className={`w-7 h-7 flex items-center justify-center rounded transition-colors ${canUndo ? "text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.06] cursor-pointer" : "text-zinc-700 cursor-default"}`}>
                    <Undo2 className="w-3.5 h-3.5" />
                  </button>
                  <button type="button" title="Yeniden Yap" disabled={!canRedo} onMouseDown={e => { e.preventDefault(); applyFormat("redo"); }}
                    className={`w-7 h-7 flex items-center justify-center rounded transition-colors ${canRedo ? "text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.06] cursor-pointer" : "text-zinc-700 cursor-default"}`}>
                    <Redo2 className="w-3.5 h-3.5" />
                  </button>
                  <div className="w-px h-4 bg-white/10 mx-1 shrink-0" />
                  {([
                    { cmd: "bold",          label: "B",  cls: "font-bold",      title: "Kalın" },
                    { cmd: "italic",        label: "I",  cls: "italic",         title: "İtalik" },
                    { cmd: "underline",     label: "U",  cls: "underline",      title: "Altçizgi" },
                    { cmd: "strikeThrough", label: "S",  cls: "line-through",   title: "Üstçizgi" },
                  ] as const).map(({ cmd, label, cls, title }) => (
                    <button
                      key={cmd}
                      type="button"
                      title={title}
                      onMouseDown={e => { e.preventDefault(); applyFormat(cmd); }}
                      className="w-7 h-7 flex items-center justify-center rounded text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.06] text-xs transition-colors"
                    >
                      <span className={cls}>{label}</span>
                    </button>
                  ))}

                  <div className="w-px h-4 bg-white/10 mx-1 shrink-0" />

                  <button
                    type="button"
                    title="Bağlantı ekle"
                    onMouseDown={e => {
                      e.preventDefault();
                      saveSelection();
                      setLinkUrl("");
                      setLinkPopover(v => !v);
                    }}
                    className={`w-7 h-7 flex items-center justify-center rounded transition-colors ${
                      linkPopover ? "text-blue-400 bg-blue-500/10" : "text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.06]"
                    }`}
                  >
                    <Link2 className="w-3.5 h-3.5" />
                  </button>

                  <div className="w-px h-4 bg-white/10 mx-1 shrink-0" />

                  <button
                    type="button"
                    title="Numaralı liste"
                    onMouseDown={e => { e.preventDefault(); applyFormat("insertOrderedList"); }}
                    className="w-7 h-7 flex items-center justify-center rounded text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.06] transition-colors"
                  >
                    <ListOrdered className="w-3.5 h-3.5" />
                  </button>
                  <button
                    type="button"
                    title="Madde işareti listesi"
                    onMouseDown={e => { e.preventDefault(); applyFormat("insertUnorderedList"); }}
                    className="w-7 h-7 flex items-center justify-center rounded text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.06] transition-colors"
                  >
                    <List className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}

              {/* Reply attachment chips */}
              {replyAttachments.length > 0 && (
                <div className="px-3 pb-1 flex flex-wrap gap-1.5">
                  {replyAttachments.map((att, idx) => (
                    <div key={idx} className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-white/[0.04] border border-white/[0.07] text-zinc-400 max-w-[200px]">
                      <AttachmentIcon mimeType={att.mimeType} />
                      <span className="text-[11px] truncate min-w-0">{att.filename}</span>
                      <span className="text-[10px] text-zinc-600 shrink-0">{formatBytes(att.size)}</span>
                      <button type="button" onClick={() => setReplyAttachments(p => p.filter((_, i) => i !== idx))} className="shrink-0 text-zinc-600 hover:text-zinc-300 transition-colors">
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {replyAttachError && (
                <div className="mx-3 mb-1.5 flex items-center gap-2 text-xs text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-2.5 py-1.5">
                  <span className="min-w-0">{replyAttachError}</span>
                  <button type="button" onClick={() => setReplyAttachError(null)} className="ml-auto shrink-0 text-red-400/60 hover:text-red-400"><X className="w-3 h-3" /></button>
                </div>
              )}

              {/* Bottom action bar */}
              <div className="px-3 py-2 border-t border-white/5 flex items-center justify-between">
                <div className="flex items-center gap-1">
                  {/* Paperclip */}
                  <button
                    type="button"
                    title="Dosya ekle"
                    onClick={() => replyFileInputRef.current?.click()}
                    className="w-7 h-7 flex items-center justify-center rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04] transition-colors"
                  >
                    <Paperclip className="w-3.5 h-3.5" />
                  </button>
                  <input ref={replyFileInputRef} type="file" multiple className="hidden" onChange={handleReplyFileSelect} />

                  {/* Formatting toggle */}
                  <button
                    type="button"
                    title="Biçimlendirme"
                    onClick={() => { setShowFormatBar(v => !v); setLinkPopover(false); }}
                    className={`flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs transition-colors ${
                      showFormatBar ? "text-blue-400 bg-blue-500/10" : "text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04]"
                    }`}
                  >
                    <Type className="w-3.5 h-3.5" />
                    <ChevronDown className={`w-3 h-3 transition-transform duration-150 ${showFormatBar ? "rotate-180" : ""}`} />
                  </button>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => { setShowReply(false); setReplyText(""); }}
                    className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
                  >
                    {tr.mail.cancel}
                  </button>
                  <button
                    type="button"
                    onClick={() => onSendReply(replyAttachments, replyEditableRef.current?.innerHTML ?? "")}
                    disabled={replyEmpty || isSending}
                    className="px-4 py-1.5 bg-blue-500 hover:bg-blue-600 disabled:opacity-40 text-white text-xs font-medium rounded-md transition-colors flex items-center gap-2"
                  >
                    {isSending ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                    {isSending ? tr.compose.sending : tr.mail.sendReply}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
