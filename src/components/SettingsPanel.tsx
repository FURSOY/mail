import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw, DownloadCloud, Menu, LogOut, Plus, GripVertical } from "lucide-react";
import { tr } from "../i18n";
import { themePresets, typography, ui, type ThemePresetName } from "../theme";
import type { Account, AppControls, DensityMode, EmailLanguage, MailDebugMetrics, OtpMode, RenderMode } from "../types";

interface SettingsPanelProps {
  isVisible: boolean;
  usesOverlaySidebar: boolean;
  onMenuOpen: () => void;

  themePreset: ThemePresetName;
  setThemePreset: (v: ThemePresetName) => void;
  densityMode: DensityMode;
  setDensityMode: (v: DensityMode) => void;

  syncIntervalValue: number;
  setSyncIntervalValue: (v: number) => void;

  launchAtStartup: boolean;
  startupSettingLoading: boolean;
  onLaunchAtStartupChange: (checked: boolean) => void;

  appControls: AppControls;
  onUpdateAppControls: (next: AppControls) => void;

  notifDuration: number;
  setNotifDuration: (v: number) => void;
  notifInfinite: boolean;
  setNotifInfinite: (v: boolean) => void;

  lazyBodyLoading: boolean;
  setLazyBodyLoading: (v: boolean) => void;
  renderMode: RenderMode;
  setRenderMode: (v: RenderMode) => void;
  otpMode: OtpMode;
  setOtpMode: (v: OtpMode) => void;
  emailLanguage: EmailLanguage;
  setEmailLanguage: (v: EmailLanguage) => void;
  pauseOnFullscreen: boolean;
  setPauseOnFullscreen: (v: boolean) => void;

  debugMetrics: MailDebugMetrics;
  onClearCaches: () => void;

  currentVersion: string;
  isCheckingUpdate: boolean;
  updateAvailable: { version: string; date: string; body: string } | null;
  updateProgress: { downloaded: number; total: number } | null;
  updateError: string | null;
  updateStatus: string;
  onCheckForUpdates: (showUI: boolean) => void;
  onInstallUpdate: () => void;
  // multi-account
  accounts: Account[];
  onAddAccount: () => void;
  onLogoutAccount: (accountId: string) => void;
  onReorderAccounts: (orderedIds: string[]) => void;
}

export function SettingsPanel({
  isVisible, usesOverlaySidebar, onMenuOpen,
  themePreset, setThemePreset, densityMode, setDensityMode,
  syncIntervalValue, setSyncIntervalValue,
  launchAtStartup, startupSettingLoading, onLaunchAtStartupChange,
  appControls, onUpdateAppControls,
  notifDuration, setNotifDuration, notifInfinite, setNotifInfinite,
  lazyBodyLoading, setLazyBodyLoading, renderMode, setRenderMode,
  otpMode, setOtpMode, emailLanguage, setEmailLanguage, pauseOnFullscreen, setPauseOnFullscreen,
  debugMetrics, onClearCaches,
  currentVersion, isCheckingUpdate, updateAvailable, updateProgress, updateError, updateStatus,
  onCheckForUpdates, onInstallUpdate,
  accounts, onAddAccount, onLogoutAccount, onReorderAccounts,
}: SettingsPanelProps) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const dragStateRef = useRef({ from: null as number | null, over: null as number | null });

  const startDrag = useCallback((index: number) => {
    dragStateRef.current = { from: index, over: null };
    setDragIndex(index);
    setDragOverIndex(null);
  }, []);

  useEffect(() => {
    if (dragIndex === null) return;
    const handleMove = (e: PointerEvent) => {
      for (const el of document.elementsFromPoint(e.clientX, e.clientY)) {
        const idx = (el as HTMLElement).dataset?.accountIdx;
        if (idx !== undefined) {
          const n = parseInt(idx);
          dragStateRef.current.over = n;
          setDragOverIndex(n);
          break;
        }
      }
    };
    const handleUp = () => {
      const { from, over } = dragStateRef.current;
      if (from !== null && over !== null && from !== over) {
        const reordered = [...accounts];
        const [moved] = reordered.splice(from, 1);
        reordered.splice(over, 0, moved);
        onReorderAccounts(reordered.map(a => a.id));
      }
      dragStateRef.current = { from: null, over: null };
      setDragIndex(null);
      setDragOverIndex(null);
    };
    window.addEventListener("pointermove", handleMove);
    window.addEventListener("pointerup", handleUp);
    return () => {
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
    };
  }, [dragIndex, accounts, onReorderAccounts]);

  return (
    <section
      className="flex-1 overflow-y-scroll overscroll-contain bg-[#0a0a0c] p-8"
      style={isVisible
        ? { contain: "paint", willChange: "scroll-position" }
        : { contain: "paint", visibility: "hidden" as const, position: "absolute" as const, width: 0, height: 0, overflow: "hidden", padding: 0 }
      }
    >
      <div className="max-w-2xl mx-auto">
        <h2 className={`${typography.pageTitle} mb-6 flex items-center gap-2`}>
          {usesOverlaySidebar && (
            <button
              type="button"
              onClick={onMenuOpen}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-zinc-500 hover:bg-white/10 hover:text-zinc-200"
              aria-label="Open menu"
              title="Open menu"
            >
              <Menu className="h-4 w-4" />
            </button>
          )}
          {tr.nav.settings}
        </h2>

        <div className="space-y-8">
          {/* Accounts */}
          <div className="bg-white/[0.02] border border-white/5 rounded-xl p-5">
            <h3 className="text-sm font-semibold text-zinc-200 mb-1">Accounts</h3>
            <p className="text-xs text-zinc-500 mb-4">Drag to reorder accounts. The top account is selected automatically on startup.</p>
            <div className="space-y-1.5">
              {accounts.map((acc, i) => (
                <div
                  key={acc.id}
                  data-account-idx={i}
                  onPointerDown={(e) => { e.preventDefault(); startDrag(i); }}
                  className={`flex items-center gap-3 p-3 rounded-lg border transition-all select-none ${
                    dragOverIndex === i && dragIndex !== i
                      ? "border-[var(--app-accent)] bg-[var(--app-accent-soft)]"
                      : dragIndex === i
                      ? "border-white/10 bg-white/[0.05] opacity-50"
                      : "border-white/5 bg-white/[0.02]"
                  }`}
                >
                  <GripVertical className={`w-4 h-4 text-zinc-600 shrink-0 ${dragIndex === i ? "cursor-grabbing" : "cursor-grab"}`} />
                  {acc.picture ? (
                    <img src={acc.picture} alt={acc.email} className="w-8 h-8 rounded-full object-cover shrink-0" />
                  ) : (
                    <div className="w-8 h-8 rounded-full bg-zinc-700 flex items-center justify-center text-sm font-bold text-zinc-300 shrink-0">
                      {acc.email[0]?.toUpperCase() ?? "?"}
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-zinc-200 truncate">{acc.email.split("@")[0]}</div>
                    <div className="text-xs text-zinc-500 truncate">{acc.email}</div>
                    {i === 0 && (
                      <div className="text-[10px] text-[var(--app-accent)] font-medium mt-0.5">Primary account</div>
                    )}
                  </div>
                  <button
                    onClick={() => onLogoutAccount(acc.id)}
                    className="flex items-center gap-1.5 px-2.5 py-1 text-xs text-zinc-500 hover:text-red-400 hover:bg-red-400/10 rounded-md transition-colors shrink-0"
                  >
                    <LogOut className="w-3.5 h-3.5" />
                    Sign out
                  </button>
                </div>
              ))}
              <button
                onClick={onAddAccount}
                className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-lg border border-dashed border-white/10 text-zinc-500 hover:text-zinc-300 hover:border-white/20 transition-colors"
              >
                <Plus className="w-4 h-4" />
                <span className="text-sm">Add account</span>
              </button>
            </div>
          </div>

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
                        className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-xs transition-all ${
                          active
                            ? "border-[var(--app-accent)] bg-[var(--app-accent-soft)] text-zinc-100"
                            : "border-white/10 bg-[#09090b] text-zinc-400 hover:bg-white/5 hover:text-zinc-200"
                        }`}
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
                      className={`px-3 py-1.5 text-xs rounded-md transition-colors ${
                        densityMode === mode ? "bg-white/10 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"
                      }`}
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
            <h3 className="text-sm font-semibold text-zinc-200 mb-1">Sync Frequency</h3>
            <p className="text-xs text-zinc-500 mb-4">How many seconds to wait between sync cycles.</p>
            <div className="flex items-center gap-3">
              <input
                type="number"
                min="1"
                max="300"
                value={syncIntervalValue}
                onChange={(e) => {
                  const val = Math.max(1, parseInt(e.target.value, 10) || 1);
                  setSyncIntervalValue(val);
                  localStorage.setItem("fursoy_sync_interval", val.toString());
                }}
                className="w-24 bg-[#09090b] border border-white/10 rounded-lg px-3 py-1.5 text-sm text-zinc-200 focus:border-blue-500/50 outline-none"
              />
              <span className="text-sm text-zinc-400">seconds</span>
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
                onChange={(e) => onLaunchAtStartupChange(e.target.checked)}
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
                  onChange={(e) => onUpdateAppControls({ ...appControls, notificationsMuted: e.target.checked })}
                  className="w-4 h-4 rounded border-white/20 bg-[#09090b] text-blue-500 focus:ring-0 focus:ring-offset-0"
                />
                <span className="text-sm text-zinc-300">{tr.notifications.muteNotifications}</span>
              </label>

              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={appControls.mailSyncPaused}
                  onChange={(e) => onUpdateAppControls({ ...appControls, mailSyncPaused: e.target.checked })}
                  className="w-4 h-4 rounded border-white/20 bg-[#09090b] text-blue-500 focus:ring-0 focus:ring-offset-0"
                />
                <span className="text-sm text-zinc-300">{tr.notifications.pauseMailSync}</span>
              </label>

              <div className="rounded-lg border border-white/5 bg-[#09090b] p-3">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={appControls.quietHoursEnabled}
                    onChange={(e) => onUpdateAppControls({ ...appControls, quietHoursEnabled: e.target.checked })}
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
                      onChange={(e) => onUpdateAppControls({ ...appControls, quietHoursStart: e.target.value })}
                      className="w-full rounded-lg border border-white/10 bg-[#0c0c0e] px-2 py-1.5 text-xs text-zinc-200 outline-none focus:border-blue-500/50 disabled:cursor-not-allowed"
                    />
                  </label>
                  <label className="space-y-1">
                    <span className="text-[10px] text-zinc-500">{tr.notifications.end}</span>
                    <input
                      type="time"
                      value={appControls.quietHoursEnd}
                      disabled={!appControls.quietHoursEnabled}
                      onChange={(e) => onUpdateAppControls({ ...appControls, quietHoursEnd: e.target.value })}
                      className="w-full rounded-lg border border-white/10 bg-[#0c0c0e] px-2 py-1.5 text-xs text-zinc-200 outline-none focus:border-blue-500/50 disabled:cursor-not-allowed"
                    />
                  </label>
                </div>
              </div>
            </div>
          </div>

          {/* Notification Duration */}
          <div className="bg-white/[0.02] border border-white/5 rounded-xl p-5">
            <h3 className="text-sm font-semibold text-zinc-200 mb-1">Notification Duration</h3>
            <p className="text-xs text-zinc-500 mb-4">How long new email notifications stay on screen.</p>

            <div className="space-y-4">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={notifInfinite}
                  onChange={(e) => {
                    setNotifInfinite(e.target.checked);
                    localStorage.setItem("fursoy_notif_infinite", e.target.checked.toString());
                  }}
                  className="w-4 h-4 rounded border-white/20 bg-[#09090b] text-blue-500 focus:ring-0 focus:ring-offset-0"
                />
                <span className="text-sm text-zinc-300">Keep on screen (no timeout)</span>
              </label>

              <div className={`flex items-center gap-3 transition-opacity ${notifInfinite ? "opacity-40 pointer-events-none" : ""}`}>
                <input
                  type="number"
                  min="1"
                  max="60"
                  value={notifDuration}
                  onChange={(e) => {
                    const val = parseInt(e.target.value, 10) || 1;
                    setNotifDuration(val);
                    localStorage.setItem("fursoy_notif_duration", val.toString());
                  }}
                  disabled={notifInfinite}
                  className="w-24 bg-[#09090b] border border-white/10 rounded-lg px-3 py-1.5 text-sm text-zinc-200 focus:border-blue-500/50 outline-none disabled:bg-transparent"
                />
                <span className="text-sm text-zinc-400">seconds</span>
              </div>
            </div>
          </div>

          {/* Performance Optimization */}
          <div className="bg-white/[0.02] border border-white/5 rounded-xl p-5">
            <h3 className="text-sm font-semibold text-zinc-200 mb-1">Performance &amp; Game Mode</h3>
            <p className="text-xs text-zinc-500 mb-4">Additional settings for efficient system resource usage.</p>

            <div className="space-y-5">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={lazyBodyLoading}
                  onChange={(e) => {
                    setLazyBodyLoading(e.target.checked);
                    localStorage.setItem("fursoy_lazy_body_loading", e.target.checked.toString());
                  }}
                  className="w-4 h-4 rounded border-white/20 bg-[#09090b] text-blue-500 focus:ring-0 focus:ring-offset-0"
                />
                <span className="text-sm text-zinc-300">Load email content only when opened</span>
              </label>

              <div>
                <div className="text-xs font-medium text-zinc-300 mb-2">HTML Render Mode</div>
                <div className="inline-flex rounded-lg border border-white/10 bg-[#09090b] p-1">
                  <button
                    type="button"
                    onClick={() => {
                      setRenderMode("full");
                      localStorage.setItem("fursoy_render_mode", "full");
                    }}
                    className={`px-3 py-1.5 text-xs rounded-md transition-colors ${renderMode === "full" ? "bg-white/10 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"}`}
                  >
                    Full HTML
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setRenderMode("simple");
                      localStorage.setItem("fursoy_render_mode", "simple");
                    }}
                    className={`px-3 py-1.5 text-xs rounded-md transition-colors ${renderMode === "simple" ? "bg-white/10 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"}`}
                  >
                    Simple
                  </button>
                </div>
              </div>

              <div>
                <div className="text-xs font-medium text-zinc-300 mb-1">OTP Detection</div>
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
                      {mode === "off" ? "Off" : mode === "balanced" ? "Balanced" : "Strict"}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className="text-xs font-medium text-zinc-300 mb-1">Email language</div>
                <p className="text-xs text-zinc-500 mb-2">Determines which OTP patterns are used for code detection.</p>
                <div className="inline-flex rounded-lg border border-white/10 bg-[#09090b] p-1">
                  {(["en", "tr"] as EmailLanguage[]).map((lang) => (
                    <button
                      key={lang}
                      type="button"
                      onClick={() => {
                        setEmailLanguage(lang);
                        localStorage.setItem("fursoy_email_language", lang);
                      }}
                      className={`px-3 py-1.5 text-xs rounded-md transition-colors ${emailLanguage === lang ? "bg-white/10 text-zinc-100" : "text-zinc-500 hover:text-zinc-300"}`}
                    >
                      {lang === "en" ? "English" : "Turkish"}
                    </button>
                  ))}
                </div>
              </div>

              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={pauseOnFullscreen}
                  onChange={(e) => {
                    setPauseOnFullscreen(e.target.checked);
                    localStorage.setItem("fursoy_pause_on_fullscreen", e.target.checked.toString());
                  }}
                  className="w-4 h-4 rounded border-white/20 bg-[#09090b] text-blue-500 focus:ring-0 focus:ring-offset-0"
                />
                <span className="text-sm text-zinc-300">Pause background network activity during fullscreen / game mode</span>
              </label>

              <div className="rounded-lg border border-white/5 bg-[#09090b] p-3">
                <div className="flex items-center justify-between gap-3 mb-2">
                  <div>
                    <div className="text-xs font-medium text-zinc-300">Approximate data usage</div>
                    <div className="text-[10px] text-zinc-600">Shown value does not include WebView2 RAM usage.</div>
                  </div>
                  <button
                    type="button"
                    onClick={onClearCaches}
                    className="px-3 py-1.5 rounded-md border border-white/10 text-xs text-zinc-300 hover:bg-white/5"
                  >
                    Clear cache
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-2 text-[10px] text-zinc-500">
                  <div>Opened content: <span className="text-zinc-300">{debugMetrics.openedCount}</span></div>
                  <div>Last content size: <span className="text-zinc-300">{Math.round(debugMetrics.lastBodyBytes / 1024)} KB</span></div>
                  <div>Cached labels: <span className="text-zinc-300">{debugMetrics.cachedLabels}</span></div>
                  <div>Cached emails: <span className="text-zinc-300">{debugMetrics.cachedMessages}</span></div>
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
                    onClick={() => onCheckForUpdates(true)}
                    disabled={isCheckingUpdate}
                    className={`${ui.buttonSecondary} flex items-center gap-2`}
                  >
                    {isCheckingUpdate ? <RefreshCw className="w-4 h-4 animate-spin" /> : <DownloadCloud className="w-4 h-4" />}
                    {isCheckingUpdate ? tr.update.checking : tr.update.check}
                  </button>
                  {updateAvailable && (
                    <button onClick={onInstallUpdate} className={ui.buttonPrimary}>
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
                      style={{ width: `${updateProgress.total > 0 ? (updateProgress.downloaded / updateProgress.total) * 100 : 0}%` }}
                    />
                  </div>
                  <p className="text-[10px] text-zinc-500 mt-2">{tr.update.restartHint}</p>
                </div>
              )}
              {updateError && <p className="text-xs text-red-400 font-medium">{updateError}</p>}
              {updateStatus && !updateError && <p className="text-xs text-emerald-400 font-medium">{updateStatus}</p>}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
