import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emitTo } from "@tauri-apps/api/event";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { X, Copy, Mail } from "lucide-react";
import "./index.css";

interface NotificationPayload {
  title: string;
  body: string;
  code?: string | null;
}

export default function NotificationWindow() {
  const [payload, setPayload] = useState<NotificationPayload | null>(null);
  const [isClosing, setIsClosing] = useState(false);

  const closeWindow = async () => {
    setIsClosing(true);
    setTimeout(async () => {
      try {
        const w = getCurrentWindow();
        await w.close();
      } catch {
        // fallback
      }
    }, 300);
  };

  // Auto-close after 5 seconds
  useEffect(() => {
    let timer: number;
    if (payload && !isClosing) {
      timer = window.setTimeout(() => {
        closeWindow();
      }, 5000);
    }
    return () => clearTimeout(timer);
  }, [payload, isClosing]);

  // On mount: read pending notification from Rust state
  useEffect(() => {
    invoke<NotificationPayload | null>("get_pending_notification").then((data) => {
      if (data) setPayload(data);
    }).catch(console.error);

    // Also listen for subsequent notifications if window is reused
    const unlisten = listen<NotificationPayload>("new-notification", (event) => {
      setPayload(event.payload);
      setIsClosing(false);
    });

    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (payload?.code) {
      await writeText(payload.code);
      closeWindow();
    }
  };

  const handleOpenMail = async () => {
    await emitTo("main", "focus-main-window");
    closeWindow();
  };

  return (
    <div
      className="w-screen h-screen overflow-hidden bg-[#18181b] text-zinc-100 select-none cursor-pointer relative flex flex-col"
      onClick={handleOpenMail}
    >
      <div
        className={`flex-1 p-4 flex flex-col gap-2 relative transition-opacity duration-300 ${
          isClosing ? "opacity-0" : "opacity-100"
        }`}
      >
        {/* Close Button */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            closeWindow();
          }}
          className="absolute top-2 right-2 w-6 h-6 flex items-center justify-center rounded-md text-zinc-500 hover:text-white hover:bg-white/10 transition-colors z-10"
        >
          <X className="w-4 h-4" />
        </button>

        {/* Content */}
        <div className="flex gap-3 items-start pr-6">
          <div className="w-8 h-8 rounded-full bg-blue-500/20 flex items-center justify-center shrink-0 mt-0.5">
            <Mail className="w-4 h-4 text-blue-400" />
          </div>
          <div className="flex flex-col gap-0.5 overflow-hidden">
            <h3 className="text-sm font-semibold text-zinc-100 truncate">
              {payload?.title || "Yükleniyor..."}
            </h3>
            <p className="text-xs text-zinc-400 line-clamp-2">
              {payload?.body || ""}
            </p>
          </div>
        </div>

        {/* Copy Code Button */}
        {payload?.code && (
          <div className="mt-1 flex justify-end">
            <button
              onClick={handleCopy}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-500 hover:bg-blue-600 text-white text-xs font-medium rounded-lg transition-colors shadow-sm"
            >
              <Copy className="w-3.5 h-3.5" />
              <span>Kodu Kopyala ({payload.code})</span>
            </button>
          </div>
        )}
      </div>

      {/* Progress Bar */}
      {payload && (
        <div className="h-0.5 bg-blue-500/60 w-full" style={{
          animation: "shrink 5s linear forwards",
        }} />
      )}
      <style>{`
        @keyframes shrink {
          from { width: 100%; }
          to { width: 0%; }
        }
        html, body { background: #18181b !important; margin: 0; padding: 0; overflow: hidden; }
      `}</style>
    </div>
  );
}
