import { X, RefreshCw, Send, ChevronDown, AlertCircle, Paperclip, FileText, Image, File, Type, Link2, List, ListOrdered, Undo2, Redo2 } from "lucide-react";
import { useState, useRef, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { tr } from "../i18n";
import { ui } from "../theme";
import type { Account, AttachmentPayload } from "../types";

// Gmail blocks these extensions (and so do we)
const BLOCKED_EXTENSIONS = new Set([
  "exe", "bat", "cmd", "com", "msi", "scr", "pif", "vbs", "vbe",
  "js", "jse", "jar", "wsf", "wsh", "ps1", "reg", "inf", "lnk",
]);

// Gmail's total attachment limit is 25 MB (MIME encoded).
// Base64 adds ~33% overhead, so we cap raw file bytes at 20 MB total.
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

interface ContactSuggestion {
  name: string;
  email: string;
}

interface ComposeModalProps {
  composeTo: string;
  setComposeTo: (v: string) => void;
  composeSubject: string;
  setComposeSubject: (v: string) => void;
  composeBody: string;
  setComposeBody: (v: string) => void;
  composeHtmlAppend: string;
  isSending: boolean;
  sendError: string | null;
  onSend: (attachments: AttachmentPayload[], body: string) => void;
  onClose: () => void;
  accounts: Account[];
  composeAccountId: string | null;
  setComposeAccountId: (id: string) => void;
}

function emailColor(email: string): string {
  let h = 0;
  for (let i = 0; i < email.length; i++) h = email.charCodeAt(i) + ((h << 5) - h);
  const palette = ["#3b82f6", "#8b5cf6", "#ec4899", "#f59e0b", "#10b981", "#06b6d4", "#ef4444", "#f97316"];
  return palette[Math.abs(h) % palette.length];
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileIcon(mimeType: string) {
  if (mimeType.startsWith("image/")) return <Image className="w-3.5 h-3.5" />;
  if (mimeType === "application/pdf" || mimeType.startsWith("text/")) return <FileText className="w-3.5 h-3.5" />;
  return <File className="w-3.5 h-3.5" />;
}

interface AttachmentItem extends AttachmentPayload {
  size: number;
}

export function ComposeModal({
  composeTo, setComposeTo,
  composeSubject, setComposeSubject,
  composeBody, setComposeBody,
  composeHtmlAppend,
  isSending,
  sendError,
  onSend,
  onClose,
  accounts,
  composeAccountId,
  setComposeAccountId,
}: ComposeModalProps) {
  const [fromOpen, setFromOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<ContactSuggestion[]>([]);
  const [suggOpen, setSuggOpen] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(0);
  const [attachments, setAttachments] = useState<AttachmentItem[]>([]);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [showFormatBar, setShowFormatBar] = useState(false);
  const [linkPopover, setLinkPopover] = useState(false);
  const [linkText, setLinkText] = useState("");
  const [linkUrl, setLinkUrl] = useState("");
  const [bodyEmpty, setBodyEmpty] = useState(true);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const fromRef = useRef<HTMLDivElement>(null);
  const toRef = useRef<HTMLInputElement>(null);
  const suggRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bodyEditableRef = useRef<HTMLDivElement>(null);
  const savedRangeRef = useRef<Range | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const activeAccount = accounts.find(a => a.id === composeAccountId) ?? accounts[0];

  useEffect(() => {
    if (!fromOpen) return;
    const h = (e: MouseEvent) => {
      if (fromRef.current && !fromRef.current.contains(e.target as Node)) setFromOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [fromOpen]);

  useEffect(() => {
    if (!suggOpen) return;
    const h = (e: MouseEvent) => {
      if (toRef.current && !toRef.current.contains(e.target as Node) &&
          suggRef.current && !suggRef.current.contains(e.target as Node)) {
        setSuggOpen(false);
      }
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [suggOpen]);

  const searchContacts = useCallback((q: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const trimmed = q.trim();
    if (trimmed.length < 1) { setSuggestions([]); setSuggOpen(false); return; }
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await invoke<ContactSuggestion[]>("search_contacts", { query: trimmed });
        setSuggestions(res);
        setSuggOpen(res.length > 0);
        setHighlightIdx(0);
      } catch { /* ignore */ }
    }, 200);
  }, []);

  const handleToChange = (v: string) => {
    setComposeTo(v);
    const token = v.split(",").pop()?.trim() ?? "";
    searchContacts(token);
  };

  const applySuggestion = (s: ContactSuggestion) => {
    const parts = composeTo.split(",");
    parts[parts.length - 1] = s.name ? `"${s.name}" <${s.email}>` : s.email;
    setComposeTo(parts.join(", ") + ", ");
    setSuggOpen(false);
    setSuggestions([]);
    setTimeout(() => toRef.current?.focus(), 0);
  };

  const handleToKeyDown = (e: React.KeyboardEvent) => {
    if (!suggOpen || suggestions.length === 0) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setHighlightIdx(i => Math.min(i + 1, suggestions.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setHighlightIdx(i => Math.max(i - 1, 0)); }
    else if (e.key === "Enter" || e.key === "Tab") {
      if (suggestions[highlightIdx]) { e.preventDefault(); applySuggestion(suggestions[highlightIdx]); }
    } else if (e.key === "Escape") { setSuggOpen(false); }
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (files.length === 0) return;

    setAttachError(null);

    // Check for blocked extensions
    const blocked = files.filter(f => {
      const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
      return BLOCKED_EXTENSIONS.has(ext);
    });
    if (blocked.length > 0) {
      setAttachError(`Engellenen dosya türü: ${blocked.map(f => f.name).join(", ")}`);
      return;
    }

    // Check total size (existing + new)
    const existingBytes = attachments.reduce((s, a) => s + a.size, 0);
    const newBytes = files.reduce((s, f) => s + f.size, 0);
    if (existingBytes + newBytes > MAX_TOTAL_BYTES) {
      const remainingMB = ((MAX_TOTAL_BYTES - existingBytes) / (1024 * 1024)).toFixed(1);
      setAttachError(`Toplam ek boyutu 20 MB'ı geçemez. Kalan: ${remainingMB} MB`);
      return;
    }

    files.forEach(file => {
      const reader = new FileReader();
      reader.onload = () => {
        const base64 = (reader.result as string).split(",")[1];
        setAttachments(prev => [...prev, {
          filename: file.name,
          mimeType: file.type || "application/octet-stream",
          data: base64,
          size: file.size,
        }]);
      };
      reader.readAsDataURL(file);
    });
  };

  const removeAttachment = (idx: number) => {
    setAttachments(prev => prev.filter((_, i) => i !== idx));
  };

  // Sync composeHtmlAppend (forward) into contenteditable
  useEffect(() => {
    if (!composeHtmlAppend || !bodyEditableRef.current) return;
    const sep = '<br/><br/><div style="border-top:1px solid rgba(255,255,255,0.08);margin:8px 0;"></div>';
    bodyEditableRef.current.innerHTML = (bodyEditableRef.current.innerHTML || "") + sep + composeHtmlAppend;
    setComposeBody(bodyEditableRef.current.innerHTML);
    setBodyEmpty(false);
  }, [composeHtmlAppend]);

  // Clear contenteditable when body state is reset to ""
  useEffect(() => {
    if (composeBody === "" && bodyEditableRef.current) {
      bodyEditableRef.current.innerHTML = "";
      setBodyEmpty(true);
    }
  }, [composeBody]);

  const syncUndoRedo = () => {
    setCanUndo(document.queryCommandEnabled("undo"));
    setCanRedo(document.queryCommandEnabled("redo"));
  };

  const applyFormat = (command: string, value?: string) => {
    bodyEditableRef.current?.focus();
    document.execCommand(command, false, value);
    setBodyEmpty(!(bodyEditableRef.current?.innerText.trim()));
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
    bodyEditableRef.current?.focus();
    if (linkText && !window.getSelection()?.toString()) {
      document.execCommand("insertHTML", false, `<a href="${linkUrl}">${linkText}</a>`);
    } else {
      document.execCommand("createLink", false, linkUrl);
    }
    setBodyEmpty(!(bodyEditableRef.current?.innerText.trim()));
    setLinkPopover(false);
    setLinkText("");
    setLinkUrl("");
  };

  const canSend = composeTo.trim().length > 0 && composeSubject.trim().length > 0 && !isSending && !bodyEmpty;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-lg bg-[#111113] border border-white/10 rounded-xl shadow-2xl flex flex-col overflow-hidden" style={{ height: "min(560px, 90vh)" }}>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
          <h3 className="text-sm font-semibold text-zinc-200">{composeHtmlAppend ? "İlet" : tr.compose.title}</h3>
          <button onClick={onClose} className="p-1 rounded hover:bg-white/10 text-zinc-400 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 flex flex-col gap-3 flex-1 overflow-hidden min-h-0">
          {/* From */}
          {accounts.length > 1 && (
            <div ref={fromRef} className="relative">
              <button
                type="button"
                onClick={() => setFromOpen(o => !o)}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-lg bg-white/[0.03] border border-white/5 hover:border-white/10 transition-colors text-left"
              >
                <span className="text-[10px] text-zinc-600 shrink-0 w-10">Kimden</span>
                {activeAccount?.picture ? (
                  <img src={activeAccount.picture} className="w-5 h-5 rounded-full shrink-0" alt="" />
                ) : (
                  <div className="w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold text-white shrink-0"
                    style={{ background: emailColor(activeAccount?.email ?? "") }}>
                    {activeAccount?.email[0]?.toUpperCase()}
                  </div>
                )}
                <span className="flex-1 min-w-0 text-xs text-zinc-300 truncate">{activeAccount?.email}</span>
                <ChevronDown className={`w-3.5 h-3.5 text-zinc-500 shrink-0 transition-transform ${fromOpen ? "rotate-180" : ""}`} />
              </button>
              {fromOpen && (
                <div className="absolute left-0 right-0 top-full mt-1 z-20 bg-[#18181b] border border-white/10 rounded-lg shadow-xl overflow-hidden">
                  {accounts.map(acc => (
                    <button key={acc.id} type="button"
                      onClick={() => { setComposeAccountId(acc.id); setFromOpen(false); }}
                      className={`w-full flex items-center gap-2.5 px-3 py-2.5 hover:bg-white/5 transition-colors text-left ${acc.id === composeAccountId ? "bg-white/[0.04]" : ""}`}
                    >
                      {acc.picture ? (
                        <img src={acc.picture} className="w-7 h-7 rounded-full shrink-0" alt="" />
                      ) : (
                        <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold text-white shrink-0"
                          style={{ background: emailColor(acc.email) }}>
                          {acc.email[0]?.toUpperCase()}
                        </div>
                      )}
                      <div className="min-w-0 flex-1">
                        <div className="text-xs text-zinc-200 truncate">{acc.email.split("@")[0]}</div>
                        <div className="text-[10px] text-zinc-500 truncate">{acc.email}</div>
                      </div>
                      {acc.id === composeAccountId && <div className="ml-auto w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0" />}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* To */}
          <div className="relative">
            <div className="relative flex items-center">
              <span className="absolute left-3 text-[10px] text-zinc-600 pointer-events-none">Kime</span>
              <input
                ref={toRef}
                value={composeTo}
                onChange={e => handleToChange(e.target.value)}
                onKeyDown={handleToKeyDown}
                onFocus={() => { if (suggestions.length > 0) setSuggOpen(true); }}
                placeholder="ornek@gmail.com"
                autoComplete="off"
                spellCheck={false}
                className={`${ui.input} pl-12`}
              />
            </div>
            {suggOpen && suggestions.length > 0 && (
              <div ref={suggRef} className="absolute left-0 right-0 top-full mt-1 z-20 bg-[#18181b] border border-white/10 rounded-lg shadow-xl overflow-hidden">
                {suggestions.map((s, i) => (
                  <button
                    key={s.email}
                    type="button"
                    onMouseDown={e => { e.preventDefault(); applySuggestion(s); }}
                    className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-left transition-colors ${i === highlightIdx ? "bg-white/10" : "hover:bg-white/5"}`}
                    onMouseEnter={() => setHighlightIdx(i)}
                  >
                    <div
                      className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold text-white shrink-0"
                      style={{ background: emailColor(s.email) }}
                    >
                      {(s.name || s.email)[0]?.toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      {s.name && <div className="text-xs text-zinc-200 truncate">{s.name}</div>}
                      <div className={`truncate ${s.name ? "text-[10px] text-zinc-500" : "text-xs text-zinc-300"}`}>{s.email}</div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Subject */}
          <div className="relative flex items-center">
            <span className="absolute left-3 text-[10px] text-zinc-600 pointer-events-none">Konu</span>
            <input
              value={composeSubject}
              onChange={e => setComposeSubject(e.target.value)}
              placeholder="E-posta konusu"
              className={`${ui.input} pl-12`}
            />
          </div>

          {/* Body — bordered container with contenteditable + bottom bar */}
          <div className="rounded-lg border border-white/[0.08] bg-white/[0.02] overflow-hidden flex flex-col flex-1 min-h-0">
            {/* Editable area — scrolls internally, never grows the modal */}
            <div className="relative px-3 pt-3 pb-2 flex-1 min-h-0 overflow-y-auto">
              {bodyEmpty && (
                <span className="absolute top-3 left-3 pointer-events-none text-zinc-600 text-sm select-none">
                  {tr.compose.body}
                </span>
              )}
              <div
                ref={bodyEditableRef}
                contentEditable
                suppressContentEditableWarning
                onInput={() => {
                  setBodyEmpty(!(bodyEditableRef.current?.innerText.trim()));
                  syncUndoRedo();
                }}
                className="outline-none text-sm text-zinc-200 [&_a]:text-blue-400 [&_a]:underline [&_b]:font-bold [&_strong]:font-bold [&_i]:italic [&_em]:italic [&_u]:underline [&_s]:line-through [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5"
                style={{ wordBreak: "break-word", minHeight: "100%" }}
              />
            </div>

            {/* Attachment chips */}
            {attachments.length > 0 && (
              <div className="px-3 pb-1.5 flex flex-wrap gap-1.5 shrink-0">
                {attachments.map((att, idx) => (
                  <div key={idx} className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-white/[0.04] border border-white/[0.07] text-zinc-400 max-w-[200px]">
                    <span className="shrink-0 text-zinc-500">{fileIcon(att.mimeType)}</span>
                    <span className="text-[11px] truncate min-w-0">{att.filename}</span>
                    <span className="text-[10px] text-zinc-600 shrink-0">{formatBytes(att.size)}</span>
                    <button type="button" onClick={() => removeAttachment(idx)} className="shrink-0 ml-0.5 text-zinc-600 hover:text-zinc-300 transition-colors">
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Attachment error */}
            {attachError && (
              <div className="mx-3 mb-1.5 shrink-0 flex items-center gap-2 text-xs text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-2.5 py-1.5">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                <span className="min-w-0">{attachError}</span>
                <button type="button" onClick={() => setAttachError(null)} className="ml-auto shrink-0 text-red-400/60 hover:text-red-400"><X className="w-3 h-3" /></button>
              </div>
            )}

            {/* Formatting toolbar */}
            {showFormatBar && (
              <div className="relative px-2 py-1 border-t border-white/[0.06] flex items-center gap-0.5 shrink-0">
                {linkPopover && (
                  <div className="absolute bottom-full left-0 mb-1 bg-[#18181b] border border-white/10 rounded-xl p-3 shadow-2xl z-50 w-64">
                    <div className="flex flex-col gap-2">
                      <input autoFocus value={linkText} onChange={e => setLinkText(e.target.value)} placeholder="Metin"
                        className="w-full bg-white/[0.05] border border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-zinc-200 outline-none focus:border-blue-500/50 placeholder:text-zinc-600" />
                      <input value={linkUrl} onChange={e => setLinkUrl(e.target.value)} placeholder="https://..."
                        className="w-full bg-white/[0.05] border border-white/10 rounded-lg px-2.5 py-1.5 text-xs text-zinc-200 outline-none focus:border-blue-500/50 placeholder:text-zinc-600"
                        onKeyDown={e => e.key === "Enter" && applyLink()} />
                      <div className="flex gap-2 justify-end pt-0.5">
                        <button type="button" onClick={() => setLinkPopover(false)} className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors">İptal</button>
                        <button type="button" onClick={applyLink} disabled={!linkUrl}
                          className="px-3 py-1 bg-blue-500 hover:bg-blue-600 disabled:opacity-40 text-white text-xs rounded-md transition-colors">Uygula</button>
                      </div>
                    </div>
                  </div>
                )}
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
                  { cmd: "bold",          label: "B", cls: "font-bold",    title: "Kalın" },
                  { cmd: "italic",        label: "I", cls: "italic",       title: "İtalik" },
                  { cmd: "underline",     label: "U", cls: "underline",    title: "Altçizgi" },
                  { cmd: "strikeThrough", label: "S", cls: "line-through", title: "Üstçizgi" },
                ] as const).map(({ cmd, label, cls, title }) => (
                  <button key={cmd} type="button" title={title}
                    onMouseDown={e => { e.preventDefault(); applyFormat(cmd); }}
                    className="w-7 h-7 flex items-center justify-center rounded text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.06] text-xs transition-colors">
                    <span className={cls}>{label}</span>
                  </button>
                ))}
                <div className="w-px h-4 bg-white/10 mx-1 shrink-0" />
                <button type="button" title="Bağlantı ekle"
                  onMouseDown={e => { e.preventDefault(); saveSelection(); setLinkUrl(""); setLinkPopover(v => !v); }}
                  className={`w-7 h-7 flex items-center justify-center rounded transition-colors ${linkPopover ? "text-blue-400 bg-blue-500/10" : "text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.06]"}`}>
                  <Link2 className="w-3.5 h-3.5" />
                </button>
                <div className="w-px h-4 bg-white/10 mx-1 shrink-0" />
                <button type="button" title="Numaralı liste"
                  onMouseDown={e => { e.preventDefault(); applyFormat("insertOrderedList"); }}
                  className="w-7 h-7 flex items-center justify-center rounded text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.06] transition-colors">
                  <ListOrdered className="w-3.5 h-3.5" />
                </button>
                <button type="button" title="Madde işareti"
                  onMouseDown={e => { e.preventDefault(); applyFormat("insertUnorderedList"); }}
                  className="w-7 h-7 flex items-center justify-center rounded text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.06] transition-colors">
                  <List className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            {/* Bottom bar — paperclip + format toggle */}
            <div className="px-2 py-1.5 border-t border-white/[0.06] flex items-center gap-1 shrink-0">
              <button type="button" title="Dosya ekle" onClick={() => fileInputRef.current?.click()}
                className="w-7 h-7 flex items-center justify-center rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04] transition-colors">
                <Paperclip className="w-3.5 h-3.5" />
              </button>
              <input ref={fileInputRef} type="file" multiple className="hidden" onChange={handleFileSelect} />
              <button type="button" title="Biçimlendirme"
                onClick={() => { setShowFormatBar(v => !v); setLinkPopover(false); }}
                className={`flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs transition-colors ${showFormatBar ? "text-blue-400 bg-blue-500/10" : "text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.04]"}`}>
                <Type className="w-3.5 h-3.5" />
                <ChevronDown className={`w-3 h-3 transition-transform duration-150 ${showFormatBar ? "rotate-180" : ""}`} />
              </button>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-white/5 space-y-2">
          {sendError && (
            <div className="flex items-center gap-2 text-xs text-red-400 bg-red-400/10 border border-red-400/20 rounded-lg px-3 py-2">
              <AlertCircle className="w-3.5 h-3.5 shrink-0" />
              <span className="min-w-0 break-words">{sendError}</span>
            </div>
          )}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <button onClick={onClose} className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors">
                {tr.compose.discard}
              </button>
            </div>
            <button
              onClick={() => onSend(attachments, bodyEditableRef.current?.innerHTML ?? "")}
              disabled={!canSend}
              className={`px-5 py-1.5 text-white text-xs font-medium rounded-lg transition-all flex items-center gap-2 ${
                isSending
                  ? "bg-blue-500/60 cursor-not-allowed"
                  : canSend
                  ? "bg-blue-500 hover:bg-blue-600 active:scale-95"
                  : "bg-blue-500/30 cursor-not-allowed opacity-50"
              }`}
            >
              {isSending ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
              {isSending ? tr.compose.sending : tr.compose.send}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
