import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Inbox, Send, Archive, Search, Command, CornerUpLeft, Trash2, RefreshCw, LogOut, X, Minus, Square, Settings, ShieldAlert, Plus, Edit3 } from "lucide-react";
import "./index.css";

interface Email {
  id: string;
  sender: string;
  recipient: string;
  subject: string;
  snippet: string;
  body_html: string;
  date: number;
  unread: boolean;
  label: string;
}

interface AuthInfo {
  access_token: string;
  email: string;
  picture: string;
}

function App() {
  const [activeTab, setActiveTab] = useState<'inbox' | 'sent' | 'archive' | 'spam' | 'trash'>('inbox');
  const [selectedMail, setSelectedMail] = useState<string | null>(null);
  const [authStatus, setAuthStatus] = useState<string>("Not authenticated");
  const [isSyncing, setIsSyncing] = useState(false);
  const [emails, setEmails] = useState<Email[]>([]);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [userInfo, setUserInfo] = useState<AuthInfo | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [showReply, setShowReply] = useState(false);
  const [replyText, setReplyText] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [showCompose, setShowCompose] = useState(false);
  const [composeTo, setComposeTo] = useState("");
  const [composeSubject, setComposeSubject] = useState("");
  const [composeBody, setComposeBody] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  const replyRef = useRef<HTMLTextAreaElement>(null);

  // Load emails from local DB
  const loadLocalEmails = async () => {
    try {
      const localEmails = await invoke<Email[]>("get_local_emails");
      setEmails(localEmails);
    } catch (e) {
      console.error("Failed to load local emails:", e);
    }
  };

  useEffect(() => {
    loadLocalEmails();
    
    invoke<AuthInfo | null>("get_auth_info").then(info => {
      if (info) {
        setUserInfo(info);
        setAccessToken(info.access_token);
        setAuthStatus("Logged in automatically");
      }
    }).catch(console.error);

    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
      if (e.key === 'Escape') {
        setShowReply(false);
        searchInputRef.current?.blur();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  async function loginWithGoogle() {
    try {
      setAuthStatus("Waiting for browser...");
      const res = await invoke<AuthInfo>("start_google_oauth");
      setUserInfo(res);
      setAccessToken(res.access_token);
      setAuthStatus("Logged in! Syncing...");
      
      setIsSyncing(true);
      await invoke("sync_emails", { accessToken: res.access_token });
      setIsSyncing(false);
      setAuthStatus("Sync complete!");
      loadLocalEmails();
    } catch (e) {
      setAuthStatus("Error: " + e);
      setIsSyncing(false);
    }
  }

  async function handleLogout() {
    try {
      await invoke("logout");
      setUserInfo(null);
      setAccessToken(null);
      setEmails([]);
      setAuthStatus("Logged out.");
    } catch (e) {
      console.error("Logout failed:", e);
    }
  }

  const handleRefresh = async () => {
    if (!accessToken) {
      setAuthStatus("Lütfen yenilemek için önce giriş yapın.");
      return;
    }
    setIsSyncing(true);
    setAuthStatus("Syncing...");
    try {
      await invoke("sync_emails", { accessToken });
      await loadLocalEmails();
      setAuthStatus("Sync complete!");
    } catch (e) {
      setAuthStatus("Error: " + e);
    }
    setIsSyncing(false);
  };

  const handleMailClick = async (mail: Email) => {
    setSelectedMail(mail.id);
    setShowReply(false);
    setReplyText("");
    if (mail.unread) {
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
    // Optimistic UI
    setEmails(prev => prev.map(e => e.id === emailId ? { ...e, label: 'archive' } : e));
    setSelectedMail(null);
    try {
      await invoke("archive_email", { accessToken, messageId: emailId });
    } catch (e) {
      console.error("Archive failed:", e);
      loadLocalEmails(); // Revert on error
    }
  };

  const handleTrash = async (emailId: string) => {
    if (!accessToken) return;
    // Optimistic UI - move to trash label
    setEmails(prev => prev.map(e => e.id === emailId ? { ...e, label: 'trash' } : e));
    setSelectedMail(null);
    try {
      await invoke("trash_email", { accessToken, messageId: emailId });
    } catch (e) {
      console.error("Trash failed:", e);
      loadLocalEmails();
    }
  };

  const handleReply = async () => {
    if (!accessToken || !activeMail || !replyText.trim()) return;
    setIsSending(true);
    try {
      // Extract email address from "Name <email>" format
      const senderMatch = activeMail.sender.match(/<([^>]+)>/);
      const to = senderMatch ? senderMatch[1] : activeMail.sender;

      await invoke("send_reply", {
        accessToken,
        to,
        subject: activeMail.subject,
        body: replyText.replace(/\n/g, "<br/>"),
        threadId: activeMail.id,
        messageId: activeMail.id,
      });
      setReplyText("");
      setShowReply(false);
    } catch (e) {
      console.error("Reply failed:", e);
    }
    setIsSending(false);
  };

  const handleComposeSend = async () => {
    if (!accessToken || !composeTo.trim() || !composeSubject.trim()) return;
    setIsSending(true);
    try {
      await invoke("send_email", {
        accessToken,
        to: composeTo,
        subject: composeSubject,
        body: composeBody.replace(/\n/g, "<br/>"),
      });
      setShowCompose(false);
      setComposeTo("");
      setComposeSubject("");
      setComposeBody("");
    } catch (e) {
      console.error("Send failed:", e);
    }
    setIsSending(false);
  };

  const activeMail = emails.find(m => m.id === selectedMail);

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

  const filteredEmails = emails.filter(email => {
    const matchesSearch = 
      email.subject.toLowerCase().includes(searchQuery.toLowerCase()) || 
      email.sender.toLowerCase().includes(searchQuery.toLowerCase()) ||
      email.snippet.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesTab = email.label === activeTab;
    return matchesSearch && matchesTab;
  });

  const unreadCount = emails.filter(e => e.unread && e.label === 'inbox').length;

  return (
    <div className="flex flex-col h-screen bg-[#09090b] text-zinc-300 font-sans overflow-hidden select-none">
      
      {/* CUSTOM TITLEBAR */}
      <div data-tauri-drag-region className="h-9 shrink-0 flex items-center justify-between pl-2 pr-0 border-b border-white/5 bg-[#09090b]" style={{ WebkitAppRegion: 'drag' } as any}>
        <div data-tauri-drag-region className="flex items-center gap-2 text-xs font-medium text-zinc-500 pl-1">
          <div className="w-4 h-4 rounded bg-blue-500 flex items-center justify-center">
            <Command className="w-2.5 h-2.5 text-white" />
          </div>
          <span className="text-zinc-400">MailApp</span>
        </div>
        <div className="flex items-center" style={{ WebkitAppRegion: 'no-drag' } as any}>
          <button 
            onClick={() => getCurrentWindow().minimize()}
            className="w-11 h-9 flex items-center justify-center text-zinc-500 hover:bg-white/10 hover:text-zinc-200 transition-colors"
          >
            <Minus className="w-4 h-4" />
          </button>
          <button 
            onClick={() => getCurrentWindow().toggleMaximize()}
            className="w-11 h-9 flex items-center justify-center text-zinc-500 hover:bg-white/10 hover:text-zinc-200 transition-colors"
          >
            <Square className="w-3 h-3" />
          </button>
          <button 
            onClick={() => getCurrentWindow().close()}
            className="w-11 h-9 flex items-center justify-center text-zinc-500 hover:bg-red-500/80 hover:text-white transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* SIDEBAR */}
        <aside className="hidden md:flex w-56 bg-[#0c0c0e] border-r border-white/5 flex-col">
          <nav className="flex-1 p-2 pt-3 space-y-0.5">
            <button 
              onClick={() => { setActiveTab('inbox'); setSelectedMail(null); setShowReply(false); }}
              className={`w-full flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-lg transition-colors ${activeTab === 'inbox' ? 'bg-white/10 text-zinc-100' : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200'}`}
            >
              <Inbox className="w-4 h-4" /> Inbox
              {unreadCount > 0 && (
                <span className="ml-auto text-[10px] bg-blue-500 text-white min-w-[18px] text-center py-0.5 px-1 rounded-full font-bold">{unreadCount}</span>
              )}
            </button>
            <button 
              onClick={() => { setActiveTab('sent'); setSelectedMail(null); setShowReply(false); }}
              className={`w-full flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-lg transition-colors ${activeTab === 'sent' ? 'bg-white/10 text-zinc-100' : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200'}`}
            >
              <Send className="w-4 h-4" /> Sent
            </button>
            <button 
              onClick={() => { setActiveTab('archive'); setSelectedMail(null); setShowReply(false); }}
              className={`w-full flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-lg transition-colors ${activeTab === 'archive' ? 'bg-white/10 text-zinc-100' : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200'}`}
            >
              <Archive className="w-4 h-4" /> Archive
          </button>

          <div className="my-2 border-t border-white/5" />

          <button 
            onClick={() => { setActiveTab('spam'); setSelectedMail(null); setShowReply(false); }}
            className={`w-full flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-lg transition-colors ${activeTab === 'spam' ? 'bg-white/10 text-zinc-100' : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200'}`}
          >
            <ShieldAlert className="w-4 h-4" /> Spam
          </button>
          <button 
            onClick={() => { setActiveTab('trash'); setSelectedMail(null); setShowReply(false); }}
            className={`w-full flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-lg transition-colors ${activeTab === 'trash' ? 'bg-white/10 text-zinc-100' : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-200'}`}
          >
            <Trash2 className="w-4 h-4" /> Trash
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
                <button 
                  onClick={handleLogout} 
                  className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-white/10 text-zinc-500 hover:text-red-400 transition-all"
                  title="Logout"
                >
                  <LogOut className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : (
              <>
                <div className="px-2 py-1 text-[10px] text-zinc-600">{authStatus}</div>
                <button onClick={loginWithGoogle} disabled={isSyncing} className="w-full flex items-center gap-3 px-3 py-2 text-sm font-medium rounded-lg text-zinc-400 hover:bg-white/5 hover:text-zinc-200 transition-colors disabled:opacity-50">
                  <Settings className="w-4 h-4" /> Login with Google
                  {isSyncing && <RefreshCw className="w-3.5 h-3.5 animate-spin text-blue-500 ml-auto" />}
                </button>
              </>
            )}
          </div>
        </aside>

        {/* Compose FAB */}
        {userInfo && (
          <button
            onClick={() => setShowCompose(true)}
            className="fixed bottom-6 right-6 z-50 w-12 h-12 rounded-full bg-blue-500 hover:bg-blue-600 text-white flex items-center justify-center shadow-lg shadow-blue-500/25 transition-all hover:scale-105 active:scale-95"
            title="Compose"
          >
            <Edit3 className="w-5 h-5" />
          </button>
        )}

        {/* Compose Modal */}
        {showCompose && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
            <div className="w-full max-w-lg bg-[#111113] border border-white/10 rounded-xl shadow-2xl flex flex-col overflow-hidden">
              <div className="flex items-center justify-between px-4 py-3 border-b border-white/5">
                <h3 className="text-sm font-semibold text-zinc-200">New Email</h3>
                <button onClick={() => setShowCompose(false)} className="p-1 rounded hover:bg-white/10 text-zinc-400"><X className="w-4 h-4" /></button>
              </div>
              <div className="p-4 space-y-3 flex-1">
                <input value={composeTo} onChange={e => setComposeTo(e.target.value)} placeholder="To" className="w-full bg-white/[0.03] border border-white/5 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-blue-500/40 select-text" />
                <input value={composeSubject} onChange={e => setComposeSubject(e.target.value)} placeholder="Subject" className="w-full bg-white/[0.03] border border-white/5 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-blue-500/40 select-text" />
                <textarea value={composeBody} onChange={e => setComposeBody(e.target.value)} placeholder="Write your message..." className="w-full bg-white/[0.03] border border-white/5 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-blue-500/40 resize-none min-h-[200px] select-text" />
              </div>
              <div className="flex items-center justify-between px-4 py-3 border-t border-white/5">
                <button onClick={() => setShowCompose(false)} className="text-xs text-zinc-500 hover:text-zinc-300">Discard</button>
                <button onClick={handleComposeSend} disabled={!composeTo.trim() || !composeSubject.trim() || isSending} className="px-5 py-1.5 bg-blue-500 hover:bg-blue-600 disabled:opacity-40 text-white text-xs font-medium rounded-lg transition-colors flex items-center gap-2">
                  {isSending ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                  {isSending ? "Sending..." : "Send"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* MAIL LIST */}
        <section className={`flex flex-col border-r border-white/5 bg-[#09090b] ${selectedMail ? 'hidden md:flex md:w-80 lg:w-96' : 'flex-1 md:w-80 lg:w-96 md:flex-none'}`}>
          <div className="h-12 flex items-center px-4 border-b border-white/5 justify-between shrink-0">
            <div className="flex items-center gap-2.5">
              <h2 className="font-semibold text-zinc-100 text-sm capitalize">{activeTab}</h2>
              {isSyncing && <span className="text-[10px] uppercase tracking-wider text-blue-500 font-semibold animate-pulse">Syncing...</span>}
            </div>
            <button onClick={handleRefresh} disabled={isSyncing || !accessToken} className="p-1.5 rounded-md hover:bg-white/10 text-zinc-500 transition-all disabled:opacity-20" title="Refresh">
              <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin text-blue-500' : ''}`} />
            </button>
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
            {filteredEmails.length === 0 && !isSyncing && (
              <div className="p-8 text-center text-zinc-600 text-xs">
                {searchQuery ? "No emails match your search." : activeTab === 'inbox' ? "Inbox is empty." : `No ${activeTab} emails.`}
              </div>
            )}
            {filteredEmails.map((mail) => (
              <div 
                key={mail.id} 
                onClick={() => handleMailClick(mail)}
                className={`px-4 py-3 border-b border-white/[0.03] cursor-pointer transition-all relative ${
                  selectedMail === mail.id 
                    ? 'bg-blue-500/10 border-l-2 border-l-blue-500' 
                    : 'hover:bg-white/[0.02] border-l-2 border-l-transparent'
                }`}
              >
                {mail.unread && <div className="absolute left-1 top-4 w-1.5 h-1.5 rounded-full bg-blue-500"></div>}
                <div className="flex justify-between items-baseline mb-0.5 gap-2">
                  <span className={`text-xs truncate ${mail.unread ? 'font-semibold text-zinc-100' : 'text-zinc-400'}`}>
                    {mail.label === 'sent' 
                      ? `To: ${(mail.recipient || '').split('<')[0].replace(/"/g, '').trim() || mail.recipient}`
                      : mail.sender.split('<')[0].replace(/"/g, '').trim()
                    }
                  </span>
                  <span className="text-[10px] text-zinc-600 shrink-0">{formatDate(mail.date)}</span>
                </div>
                <h3 className={`text-xs truncate ${mail.unread ? 'text-zinc-200 font-medium' : 'text-zinc-500'}`}>{mail.subject}</h3>
                <p className="text-[11px] text-zinc-600 mt-0.5 truncate">{mail.snippet}</p>
              </div>
            ))}
          </div>
        </section>

        {/* MAIL DETAIL */}
        {activeMail ? (
          <main className="flex-1 flex flex-col bg-[#0a0a0c] relative z-10">
            {/* Mobile Back Button */}
            <div className="md:hidden h-12 flex items-center px-4 border-b border-white/5 shrink-0">
              <button onClick={() => { setSelectedMail(null); setShowReply(false); }} className="flex items-center gap-2 text-xs text-zinc-400 hover:text-zinc-200">
                <CornerUpLeft className="w-3.5 h-3.5" /> Back
              </button>
            </div>

            {/* Desktop Toolbar */}
            <div className="hidden md:flex h-12 items-center justify-between px-5 border-b border-white/5 shrink-0">
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-zinc-500 flex items-center gap-1.5 capitalize">
                  {activeTab === 'inbox' && <Inbox className="w-3.5 h-3.5" />}
                  {activeTab === 'sent' && <Send className="w-3.5 h-3.5" />}
                  {activeTab === 'archive' && <Archive className="w-3.5 h-3.5" />}
                  {activeTab}
                </span>
              </div>
              <div className="flex items-center gap-0.5">
                <button 
                  onClick={() => { setShowReply(!showReply); setTimeout(() => replyRef.current?.focus(), 100); }}
                  className={`p-2 rounded-md hover:bg-white/5 transition-colors ${showReply ? 'text-blue-400 bg-blue-500/10' : 'text-zinc-400 hover:text-zinc-200'}`}
                  title="Reply (R)"
                >
                  <CornerUpLeft className="w-4 h-4" />
                </button>
                {activeTab !== 'archive' && (
                  <button 
                    onClick={() => handleArchive(activeMail.id)}
                    className="p-2 rounded-md hover:bg-white/5 text-zinc-400 hover:text-amber-400 transition-colors" 
                    title="Archive (E)"
                  >
                    <Archive className="w-4 h-4" />
                  </button>
                )}
                <button 
                  onClick={() => handleTrash(activeMail.id)}
                  className="p-2 rounded-md hover:bg-white/5 text-zinc-400 hover:text-red-400 transition-colors" 
                  title="Delete (#)"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>
            
            <div className="flex-1 overflow-y-auto p-6 md:p-8 flex flex-col">
              <div className="max-w-3xl mx-auto w-full flex-1 flex flex-col">
                <h1 className="text-xl font-bold text-zinc-100 mb-5 shrink-0">{activeMail.subject}</h1>
                <div className="flex items-center justify-between mb-5 pb-5 border-b border-white/5 shrink-0">
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-full bg-gradient-to-tr from-blue-500 to-purple-500 flex items-center justify-center text-white text-sm font-bold shrink-0">
                      {activeMail.sender.charAt(0).toUpperCase() || "U"}
                    </div>
                    <div>
                      <div className="text-sm font-medium text-zinc-200">{activeMail.sender.split('<')[0].replace(/"/g, '').trim()}</div>
                      <div className="text-[11px] text-zinc-600 mt-0.5">
                        {activeTab === 'sent' ? 'from me' : 'to me'} · {formatDateFull(activeMail.date)}
                      </div>
                    </div>
                  </div>
                  {/* Mobile action buttons */}
                  <div className="flex md:hidden items-center gap-1">
                    <button onClick={() => { setShowReply(!showReply); }} className="p-2 rounded-md hover:bg-white/5 text-zinc-400">
                      <CornerUpLeft className="w-4 h-4" />
                    </button>
                    <button onClick={() => handleArchive(activeMail.id)} className="p-2 rounded-md hover:bg-white/5 text-zinc-400">
                      <Archive className="w-4 h-4" />
                    </button>
                    <button onClick={() => handleTrash(activeMail.id)} className="p-2 rounded-md hover:bg-white/5 text-zinc-400">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                <div className="flex-1 bg-white rounded-lg overflow-hidden min-h-[400px]">
                  <iframe
                    srcDoc={`
                      <!DOCTYPE html>
                      <html>
                        <head>
                          <base target="_blank" href="https://mail.google.com/">
                          <style>
                            body { margin: 0; padding: 1rem; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; word-wrap: break-word; font-size: 14px; line-height: 1.6; color: #1a1a1a; }
                            img { max-width: 100%; height: auto; }
                            a { color: #2563eb; }
                          </style>
                        </head>
                        <body>
                          ${activeMail.body_html || activeMail.snippet}
                        </body>
                      </html>
                    `}
                    sandbox="allow-popups allow-popups-to-escape-sandbox allow-same-origin"
                    className="w-full h-full border-none"
                    title="Email Body"
                  />
                </div>

                {/* Reply Box */}
                {showReply && (
                  <div className="mt-4 rounded-lg border border-white/10 bg-white/[0.02] overflow-hidden">
                    <div className="px-4 py-2.5 border-b border-white/5 flex items-center gap-2">
                      <CornerUpLeft className="w-3.5 h-3.5 text-zinc-500" />
                      <span className="text-xs text-zinc-400">
                        Reply to <span className="text-zinc-300">{activeMail.sender.split('<')[0].replace(/"/g, '').trim()}</span>
                      </span>
                    </div>
                    <textarea
                      ref={replyRef}
                      value={replyText}
                      onChange={(e) => setReplyText(e.target.value)}
                      placeholder="Write your reply..."
                      className="w-full bg-transparent p-4 text-sm text-zinc-200 placeholder:text-zinc-600 outline-none resize-none min-h-[120px] select-text"
                    />
                    <div className="px-4 py-2.5 border-t border-white/5 flex items-center justify-between">
                      <button 
                        onClick={() => { setShowReply(false); setReplyText(""); }}
                        className="text-xs text-zinc-500 hover:text-zinc-300 transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={handleReply}
                        disabled={!replyText.trim() || isSending}
                        className="px-4 py-1.5 bg-blue-500 hover:bg-blue-600 disabled:opacity-40 disabled:hover:bg-blue-500 text-white text-xs font-medium rounded-md transition-colors flex items-center gap-2"
                      >
                        {isSending ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
                        {isSending ? "Sending..." : "Send Reply"}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </main>
        ) : (
          <main className="hidden md:flex flex-1 items-center justify-center bg-[#0a0a0c]">
            <div className="text-center">
              <div className="w-14 h-14 rounded-2xl bg-white/[0.03] flex items-center justify-center mx-auto mb-3">
                <Inbox className="w-7 h-7 text-zinc-700" />
              </div>
              <h3 className="text-zinc-500 font-medium text-sm">No message selected</h3>
              <p className="text-xs text-zinc-700 mt-1">Select an email to read it here.</p>
            </div>
          </main>
        )}
      </div>
    </div>
  );
}

export default App;
