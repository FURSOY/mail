import { Mail, ShieldCheck, Cpu, Zap } from "lucide-react";

interface OnboardingProps {
  onConnect: () => void;
  isConnecting: boolean;
}

export function Onboarding({ onConnect, isConnecting }: OnboardingProps) {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen bg-[#0a0a0c] px-8 select-none">
      <div className="w-full max-w-sm flex flex-col items-center gap-8">

        {/* Logo */}
        <div className="flex flex-col items-center gap-3">
          <div className="w-14 h-14 rounded-2xl bg-blue-600 flex items-center justify-center shadow-lg shadow-blue-900/40">
            <Mail className="w-7 h-7 text-white" />
          </div>
          <div className="text-center">
            <h1 className="text-xl font-semibold text-zinc-100 tracking-tight">FURSOY Mail</h1>
            <p className="text-sm text-zinc-500 mt-0.5">Instant Gmail notifications on Windows</p>
          </div>
        </div>

        {/* Features */}
        <div className="w-full flex flex-col gap-3">
          <Feature icon={<Zap className="w-4 h-4 text-blue-400" />} text="OTP codes detected and copied in one click" />
          <Feature icon={<ShieldCheck className="w-4 h-4 text-blue-400" />} text="No servers — your emails stay on your device" />
          <Feature icon={<Cpu className="w-4 h-4 text-blue-400" />} text="5 MB app · ~45 MB RAM · launches with Windows" />
        </div>

        {/* CTA */}
        <div className="w-full flex flex-col items-center gap-3">
          <button
            onClick={onConnect}
            disabled={isConnecting}
            className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-60 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
          >
            {isConnecting ? (
              <>
                <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
                </svg>
                Waiting for browser…
              </>
            ) : (
              <>
                <GoogleIcon />
                Connect Gmail Account
              </>
            )}
          </button>
          <p className="text-xs text-zinc-600 text-center">
            Read-only OAuth access · no data leaves your computer
          </p>
        </div>

      </div>
    </div>
  );
}

function Feature({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex items-center gap-3 px-4 py-3 rounded-lg bg-white/[0.03] border border-white/5">
      <div className="shrink-0">{icon}</div>
      <span className="text-sm text-zinc-400">{text}</span>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/>
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
    </svg>
  );
}
