export const ui = {
  card: "rounded-lg border border-white/5 bg-white/[0.02]",
  panel: "bg-[#09090b] border border-white/10 rounded-lg",
  iconButton: "p-2 rounded-md hover:bg-white/5 text-zinc-400 hover:text-zinc-200 transition-colors",
  buttonPrimary:
    "px-4 py-2 bg-[var(--app-accent)] hover:bg-[var(--app-accent-hover)] text-white rounded-lg text-sm font-semibold transition-colors shadow-lg shadow-blue-500/20 disabled:opacity-50",
  buttonSecondary:
    "px-4 py-2 bg-[#09090b] hover:bg-white/5 border border-white/10 rounded-lg text-sm text-zinc-200 font-medium transition-colors disabled:opacity-50",
  input:
    "w-full bg-white/[0.03] border border-white/5 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-[var(--app-accent)]/50 select-text",
};

export const typography = {
  pageTitle: "text-2xl font-bold text-zinc-100",
  sectionTitle: "text-sm font-semibold text-zinc-200",
  bodyMuted: "text-xs text-zinc-500",
};
