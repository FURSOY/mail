import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { X, Copy, Mail, DownloadCloud } from "lucide-react";
import "./index.css";

interface NotificationPayload {
  title: string;
  body: string;
  kind?: "mail" | "update" | null;
  code?: string | null;
  emailId?: string | null;
  duration?: number | null;
  accountId?: string | null;
  accountPicture?: string | null;
}

export default function NotificationWindow() {
  const [payload, setPayload] = useState<NotificationPayload | null>(null);
  const [isClosing, setIsClosing] = useState(false);

  const closeWindow = async () => {
    setIsClosing(true);
    setTimeout(async () => {
      try {
        await getCurrentWindow().close();
      } catch {}
    }, 300);
  };

  const handleOpen = async () => {
    try {
      await invoke("focus_main_window");
      if (payload?.kind === "update") {
        await emit("open-update-settings");
      } else if (payload?.emailId) {
        await emit("open-notification-mail", { emailId: payload.emailId, accountId: payload.accountId });
      }
    } catch (e) {
      console.error("focus_main_window failed:", e);
    }
    closeWindow();
  };

  // Auto-close after payload duration; duration 0 keeps the notification visible.
  useEffect(() => {
    let timer: number;
    if (payload && !isClosing) {
      const duration = payload.duration ?? 5000;
      if (duration > 0) {
        timer = window.setTimeout(() => closeWindow(), duration);
      }
    }
    return () => clearTimeout(timer);
  }, [payload, isClosing]);

  // On mount: read pending notification from Rust state
  useEffect(() => {
    invoke<NotificationPayload | null>("get_pending_notification").then((data) => {
      if (data) setPayload(data);
    }).catch(console.error);

    const unlisten = listen<NotificationPayload>("new-notification", (event) => {
      setPayload(event.payload);
      setIsClosing(false);
    });

    return () => { unlisten.then((f) => f()); };
  }, []);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (payload?.code) {
      await writeText(payload.code);
      closeWindow();
    }
  };

  const isUpdate = payload?.kind === "update";
  const duration = payload?.duration ?? 5000;
  const Icon = isUpdate ? DownloadCloud : Mail;
  const showAccountAvatar = !isUpdate && !!payload?.accountId;
  const palette = isUpdate
    ? {
        background: "#1f1808",
        iconBg: "rgba(245,158,11,0.18)",
        iconColor: "#fbbf24",
        title: "#fff7ed",
        body: "#fcd9a8",
        progress: "#f59e0b",
      }
    : {
        background: "#18181b",
        iconBg: "rgba(59,130,246,0.2)",
        iconColor: "#60a5fa",
        title: "#f4f4f5",
        body: "#a1a1aa",
        progress: "#3b82f6",
      };

  return (
    <>
      <style>{`
        @keyframes shrink { from { width: 100%; } to { width: 0%; } }
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        html { height: 100%; }
        body { height: 100%; background: ${palette.background} !important; overflow: hidden !important; }
        #root { height: 100%; }
      `}</style>

      {/* Full window container — fills 100% of the window height */}
      <div
        onClick={handleOpen}
        style={{
          height: "100%",
          display: "flex",
          flexDirection: "column",
          background: palette.background,
          color: "#f4f4f5",
          userSelect: "none",
          cursor: "pointer",
          overflow: "hidden",
        }}
      >
        {/* Content area — flex:1 pushes progress bar to bottom */}
        <div
          style={{
            flex: 1,
            padding: 16,
            display: "flex",
            flexDirection: "column",
            gap: 8,
            position: "relative",
            opacity: isClosing ? 0 : 1,
            transition: "opacity 300ms",
            minHeight: 0,
          }}
        >
          {/* Close Button */}
          <button
            onClick={(e) => { e.stopPropagation(); closeWindow(); }}
            style={{
              position: "absolute", top: 8, right: 8, width: 24, height: 24,
              display: "flex", alignItems: "center", justifyContent: "center",
              borderRadius: 6, color: "#71717a", background: "transparent",
              border: "none", cursor: "pointer", zIndex: 10,
            }}
          >
            <X style={{ width: 16, height: 16 }} />
          </button>

          {/* Mail content */}
          <div style={{ display: "flex", gap: 12, alignItems: "flex-start", paddingRight: 24 }}>
            {showAccountAvatar ? (
              payload?.accountPicture ? (
                <img
                  src={payload.accountPicture}
                  style={{ width: 32, height: 32, borderRadius: "50%", flexShrink: 0, marginTop: 2, objectFit: "cover" }}
                  alt=""
                />
              ) : (
                <div style={{
                  width: 32, height: 32, borderRadius: "50%", flexShrink: 0, marginTop: 2,
                  background: palette.iconBg, display: "flex", alignItems: "center", justifyContent: "center",
                  fontSize: 14, fontWeight: 700, color: palette.iconColor,
                }}>
                  {(payload?.accountId?.[0] ?? "?").toUpperCase()}
                </div>
              )
            ) : (
              <div style={{
                width: 32, height: 32, borderRadius: "50%",
                background: palette.iconBg, display: "flex",
                alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: 2,
              }}>
                <Icon style={{ width: 16, height: 16, color: palette.iconColor }} />
              </div>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 2, overflow: "hidden", minWidth: 0 }}>
              <div style={{
                fontSize: 14, fontWeight: 600, color: palette.title,
                whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
              }}>
                {payload?.title || "Yükleniyor..."}
              </div>
              <div style={{
                fontSize: 12, color: palette.body, lineHeight: 1.4,
                display: "-webkit-box", WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical" as any, overflow: "hidden",
              }}>
                {payload?.body || ""}
              </div>
            </div>
          </div>

          {/* Copy Code Button */}
          {payload?.code && (
            <div style={{ marginTop: 4, display: "flex", justifyContent: "flex-end" }}>
              <button
                onClick={handleCopy}
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  padding: "6px 12px", background: "#3b82f6", color: "white",
                  fontSize: 12, fontWeight: 500, borderRadius: 8,
                  border: "none", cursor: "pointer",
                }}
              >
                <Copy style={{ width: 14, height: 14 }} />
                <span>Kodu Kopyala ({payload.code})</span>
              </button>
            </div>
          )}
        </div>

        {/* Progress bar — always at the very bottom edge of the window */}
        {payload && duration > 0 && (
          <div style={{ width: "100%", height: 3, flexShrink: 0 }}>
            <div style={{
              height: 3, background: palette.progress,
              animation: `shrink ${duration}ms linear forwards`,
            }} />
          </div>
        )}
      </div>
    </>
  );
}
