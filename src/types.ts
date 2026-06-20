export type OtpMode = "off" | "balanced" | "strict";
export type RenderMode = "full" | "simple";
export type MailZoom = "fit" | number;
export type DensityMode = "comfortable" | "compact";
export type MailViewMode = "split" | "single-toggle" | "inbox-first";
export type MailViewPreference = "auto" | MailViewMode;

export interface Account {
  id: string;       // same as email
  email: string;
  picture: string;
  display_order: number;
}

export interface EmailSummary {
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
  account_id: string;
}

export interface ThreadGroup {
  latestEmail: EmailSummary;
  hasUnread: boolean;
  count: number;
  participants: string[];
}

export interface MailDebugMetrics {
  openedCount: number;
  lastBodyBytes: number;
  cachedLabels: number;
  cachedMessages: number;
}

export interface AuthInfo {
  access_token: string;
  email: string;
  picture: string;
}

export interface AppControls {
  notificationsMuted: boolean;
  mailSyncPaused: boolean;
  quietHoursEnabled: boolean;
  quietHoursStart: string;
  quietHoursEnd: string;
}

export const DEFAULT_APP_CONTROLS: AppControls = {
  notificationsMuted: false,
  mailSyncPaused: false,
  quietHoursEnabled: false,
  quietHoursStart: "22:00",
  quietHoursEnd: "08:00",
};
