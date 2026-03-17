export const AGENT_CHAT_HISTORY_KEY = 'agentChatHistory';
export const CHAT_INDEX_KEY = 'agentChatIndex';
export const MAX_HISTORY_MESSAGES = 50;

export type AgentChatRole = 'assistant' | 'user';

export interface AgentChatMessage {
  confidence?: number;
  content: string;
  role: AgentChatRole;
  warnings?: string[];
}

export interface ChatEntry {
  id: string;
  title: string;
  createdAt: number;
}

export interface ApiConfig {
  baseUrl: string;
  getToken: () => string | null;
}

/**
 * Manages multiple chat conversations per user.
 * When authenticated with an API config, syncs to server (encrypted at rest).
 * Falls back to localStorage when offline or unauthenticated.
 */
export class AgentChatHistoryService {
  private messages: AgentChatMessage[] = [];
  private readonly userId: string | undefined;
  private currentChatId: string;
  private apiConfig: ApiConfig | null = null;
  private serverMode = false;
  private cachedIndex: ChatEntry[] | null = null;

  public constructor(userId?: string, apiConfig?: ApiConfig) {
    this.userId = userId;
    this.apiConfig = apiConfig ?? null;

    // Migrate old single-chat history into per-chat format
    this.migrateOldHistory();

    // Load or create the active chat from localStorage (initial state)
    const index = this.getLocalIndex();
    if (index.length > 0) {
      this.currentChatId = index[0].id;
    } else {
      this.currentChatId = this.createLocalChatEntry();
    }
    this.messages = this.loadLocalMessages();
  }

  /**
   * Load chat index from server. If server has chats, switch to server mode.
   * If server is empty but localStorage has chats, bulk sync them up.
   */
  public async loadFromServer(): Promise<void> {
    if (!this.apiConfig || !this.apiConfig.getToken()) return;

    try {
      const res = await this.apiFetch('/api/chats');
      if (!res.ok) return;

      const data = (await res.json()) as { chats: Array<{ id: string; title: string; createdAt: string }> };
      const serverChats = data.chats ?? [];

      if (serverChats.length > 0) {
        // Server has chats — use server mode
        this.serverMode = true;
        this.cachedIndex = serverChats.map((c) => ({
          id: c.id,
          title: c.title,
          createdAt: new Date(c.createdAt).getTime()
        }));
        // Switch to the most recent server chat
        this.currentChatId = this.cachedIndex[0].id;
        await this.loadServerMessages(this.currentChatId);
        // Clear localStorage chat data since server is authoritative
        this.clearLocalStorage();
        return;
      }

      // Server empty — check if localStorage has chats to sync
      const localIndex = this.getLocalIndex();
      if (localIndex.length > 0 && localIndex.some((c) => this.loadLocalMessagesForChat(c.id).length > 0)) {
        await this.syncToServer(localIndex);
        this.clearLocalStorage();
      } else {
        // Both empty — server mode with no chats
        this.serverMode = true;
        this.cachedIndex = [];
      }
    } catch {
      // Server unreachable — stay in localStorage mode
    }
  }

  private async syncToServer(localIndex: ChatEntry[]): Promise<void> {
    const chats = localIndex.map((entry) => ({
      title: entry.title,
      createdAt: entry.createdAt,
      messages: this.loadLocalMessagesForChat(entry.id).map((m) => ({
        role: m.role,
        content: m.content,
        confidence: m.confidence,
        warnings: m.warnings
      }))
    })).filter((c) => c.messages.length > 0);

    if (chats.length === 0) {
      this.serverMode = true;
      this.cachedIndex = [];
      return;
    }

    const res = await this.apiFetch('/api/chats/sync', {
      method: 'POST',
      body: JSON.stringify({ chats })
    });

    if (res.ok) {
      this.serverMode = true;
      // Reload index from server
      const indexRes = await this.apiFetch('/api/chats');
      if (indexRes.ok) {
        const data = (await indexRes.json()) as { chats: Array<{ id: string; title: string; createdAt: string }> };
        this.cachedIndex = (data.chats ?? []).map((c) => ({
          id: c.id,
          title: c.title,
          createdAt: new Date(c.createdAt).getTime()
        }));
        if (this.cachedIndex.length > 0) {
          this.currentChatId = this.cachedIndex[0].id;
          await this.loadServerMessages(this.currentChatId);
        }
      }
    }
  }

  private async loadServerMessages(chatId: string): Promise<void> {
    try {
      const res = await this.apiFetch(`/api/chats/${chatId}/messages`);
      if (!res.ok) return;
      const data = (await res.json()) as { messages: AgentChatMessage[] };
      this.messages = data.messages ?? [];
    } catch {
      // Keep current in-memory messages
    }
  }

  // ── Migration (localStorage only) ──

  private migrateOldHistory(): void {
    const oldKey = this.userId
      ? `${AGENT_CHAT_HISTORY_KEY}_${this.userId}`
      : AGENT_CHAT_HISTORY_KEY;

    const oldData = localStorage.getItem(oldKey);
    if (!oldData) return;

    const existingIndex = this.getLocalIndex();
    if (existingIndex.length > 0) {
      localStorage.removeItem(oldKey);
      return;
    }

    try {
      const parsed = JSON.parse(oldData);
      if (!Array.isArray(parsed) || parsed.length === 0) {
        localStorage.removeItem(oldKey);
        return;
      }

      const chatId = `chat_migrated_${Date.now()}`;
      const firstUserMsg = parsed.find((m: { role?: string; content?: string }) => m.role === 'user');
      const title = firstUserMsg?.content
        ? (firstUserMsg.content.length > 40 ? firstUserMsg.content.slice(0, 40) + '...' : firstUserMsg.content)
        : 'Previous Chat';

      const entry: ChatEntry = { id: chatId, title, createdAt: Date.now() };
      this.saveLocalIndex([entry]);
      localStorage.setItem(this.localChatKey(chatId), oldData);
      localStorage.removeItem(oldKey);
    } catch {
      localStorage.removeItem(oldKey);
    }
  }

  // ── Public API (same interface as before) ──

  public getIndex(): ChatEntry[] {
    if (this.serverMode && this.cachedIndex) {
      return [...this.cachedIndex];
    }
    return this.getLocalIndex();
  }

  public getCurrentChatId(): string {
    return this.currentChatId;
  }

  public getMessages(): AgentChatMessage[] {
    return [...this.messages];
  }

  public async switchChat(chatId: string): Promise<void> {
    // Persist current in-memory messages
    if (!this.serverMode) {
      this.persistLocalMessages();
    }
    this.currentChatId = chatId;
    if (this.serverMode) {
      await this.loadServerMessages(chatId);
    } else {
      this.messages = this.loadLocalMessages();
    }
  }

  public async newChat(): Promise<string> {
    if (!this.serverMode) {
      this.persistLocalMessages();
    }

    if (this.serverMode) {
      try {
        const res = await this.apiFetch('/api/chats', {
          method: 'POST',
          body: JSON.stringify({ title: 'New Chat' })
        });
        if (res.ok) {
          const data = (await res.json()) as { id: string };
          const entry: ChatEntry = { id: data.id, title: 'New Chat', createdAt: Date.now() };
          this.cachedIndex = [entry, ...(this.cachedIndex ?? [])];
          this.currentChatId = data.id;
          this.messages = [];
          return data.id;
        }
      } catch { /* fall through to local */ }
    }

    const id = this.createLocalChatEntry();
    this.currentChatId = id;
    this.messages = [];
    return id;
  }

  public async deleteChat(chatId: string): Promise<void> {
    if (this.serverMode) {
      try {
        await this.apiFetch(`/api/chats/${chatId}`, { method: 'DELETE' });
      } catch { /* ignore */ }
      this.cachedIndex = (this.cachedIndex ?? []).filter((e) => e.id !== chatId);
    } else {
      const index = this.getLocalIndex().filter((e) => e.id !== chatId);
      this.saveLocalIndex(index);
      localStorage.removeItem(this.localChatKey(chatId));
    }

    if (chatId === this.currentChatId) {
      const index = this.getIndex();
      if (index.length > 0) {
        this.currentChatId = index[0].id;
        if (this.serverMode) {
          await this.loadServerMessages(this.currentChatId);
        } else {
          this.messages = this.loadLocalMessages();
        }
      } else {
        const newId = await this.newChat();
        this.currentChatId = newId;
        this.messages = [];
      }
    }
  }

  public renameChat(chatId: string, title: string): void {
    if (this.serverMode) {
      this.apiFetch(`/api/chats/${chatId}`, {
        method: 'PATCH',
        body: JSON.stringify({ title })
      }).catch(() => {});
      const entry = (this.cachedIndex ?? []).find((e) => e.id === chatId);
      if (entry) entry.title = title;
    } else {
      const index = this.getLocalIndex();
      const entry = index.find((e) => e.id === chatId);
      if (entry) {
        entry.title = title;
        this.saveLocalIndex(index);
      }
    }
  }

  public appendUserMessage(content: string): void {
    this.appendMessage({ content, role: 'user' });
    this.autoTitle(content);
  }

  public appendAssistantMessage(
    content: string,
    meta?: { confidence?: number; warnings?: string[] }
  ): void {
    this.appendMessage({
      confidence: meta?.confidence,
      content,
      role: 'assistant',
      warnings: meta?.warnings
    });
  }

  public appendAssistantMessageToChat(
    chatId: string,
    content: string,
    meta?: { confidence?: number; warnings?: string[] }
  ): void {
    const msg: AgentChatMessage = {
      confidence: meta?.confidence,
      content,
      role: 'assistant',
      warnings: meta?.warnings
    };

    if (chatId === this.currentChatId) {
      this.appendMessage(msg);
      return;
    }

    // Save to a different chat
    if (this.serverMode) {
      this.apiFetch(`/api/chats/${chatId}/messages`, {
        method: 'POST',
        body: JSON.stringify(msg)
      }).catch(() => {});
    } else {
      const key = this.localChatKey(chatId);
      let messages: AgentChatMessage[] = [];
      try {
        const raw = localStorage.getItem(key);
        if (raw) messages = JSON.parse(raw) as AgentChatMessage[];
      } catch { /* ignore */ }
      messages.push(msg);
      localStorage.setItem(key, JSON.stringify(messages.slice(-MAX_HISTORY_MESSAGES)));
    }
  }

  public clear(): void {
    this.messages = [];
    if (this.serverMode) {
      // Delete all messages for current chat on server
      this.apiFetch(`/api/chats/${this.currentChatId}`, { method: 'DELETE' }).catch(() => {});
    } else {
      localStorage.removeItem(this.localChatKey(this.currentChatId));
    }
  }

  public static removeUnscopedHistory(): void {
    localStorage.removeItem(AGENT_CHAT_HISTORY_KEY);
  }

  // ── Private helpers ──

  private appendMessage(message: AgentChatMessage): void {
    this.messages = [...this.messages, message].slice(-MAX_HISTORY_MESSAGES);

    if (this.serverMode) {
      this.apiFetch(`/api/chats/${this.currentChatId}/messages`, {
        method: 'POST',
        body: JSON.stringify(message)
      }).catch(() => {});
    } else {
      this.persistLocalMessages();
    }
  }

  private autoTitle(userMessage: string): void {
    const title = userMessage.length > 40
      ? userMessage.slice(0, 40) + '...'
      : userMessage;

    if (this.serverMode) {
      const entry = (this.cachedIndex ?? []).find((e) => e.id === this.currentChatId);
      if (entry && entry.title === 'New Chat') {
        entry.title = title;
        this.apiFetch(`/api/chats/${this.currentChatId}`, {
          method: 'PATCH',
          body: JSON.stringify({ title })
        }).catch(() => {});
      }
    } else {
      const index = this.getLocalIndex();
      const entry = index.find((e) => e.id === this.currentChatId);
      if (entry && entry.title === 'New Chat') {
        entry.title = title;
        this.saveLocalIndex(index);
      }
    }
  }

  // ── API helpers ──

  private apiFetch(path: string, opts?: RequestInit): Promise<Response> {
    const token = this.apiConfig?.getToken();
    return fetch(`${this.apiConfig?.baseUrl ?? ''}${path}`, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(opts?.headers ?? {})
      }
    });
  }

  // ── localStorage helpers ──

  private localIndexKey(): string {
    return this.userId ? `${CHAT_INDEX_KEY}_${this.userId}` : CHAT_INDEX_KEY;
  }

  private localChatKey(chatId: string): string {
    const base = this.userId
      ? `${AGENT_CHAT_HISTORY_KEY}_${this.userId}`
      : AGENT_CHAT_HISTORY_KEY;
    return `${base}__${chatId}`;
  }

  private getLocalIndex(): ChatEntry[] {
    try {
      const raw = localStorage.getItem(this.localIndexKey());
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (e: unknown) =>
          typeof (e as ChatEntry)?.id === 'string' &&
          typeof (e as ChatEntry)?.title === 'string'
      );
    } catch {
      return [];
    }
  }

  private saveLocalIndex(index: ChatEntry[]): void {
    localStorage.setItem(this.localIndexKey(), JSON.stringify(index));
  }

  private createLocalChatEntry(): string {
    const id = `chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const entry: ChatEntry = { id, title: 'New Chat', createdAt: Date.now() };
    const index = this.getLocalIndex();
    index.unshift(entry);
    this.saveLocalIndex(index);
    return id;
  }

  private loadLocalMessages(): AgentChatMessage[] {
    return this.loadLocalMessagesForChat(this.currentChatId);
  }

  private loadLocalMessagesForChat(chatId: string): AgentChatMessage[] {
    const rawValue = localStorage.getItem(this.localChatKey(chatId));
    if (!rawValue) return [];
    try {
      const parsed = JSON.parse(rawValue);
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((entry: Record<string, unknown>) =>
          typeof entry?.content === 'string' &&
          (entry?.role === 'assistant' || entry?.role === 'user')
        )
        .map((entry: Record<string, unknown>) => ({
          confidence: typeof entry.confidence === 'number' ? entry.confidence : undefined,
          content: entry.content as string,
          role: entry.role as AgentChatRole,
          warnings: Array.isArray(entry.warnings)
            ? (entry.warnings as unknown[]).filter((w): w is string => typeof w === 'string')
            : undefined
        }))
        .slice(-MAX_HISTORY_MESSAGES);
    } catch {
      return [];
    }
  }

  private persistLocalMessages(): void {
    localStorage.setItem(
      this.localChatKey(this.currentChatId),
      JSON.stringify(this.messages)
    );
  }

  private clearLocalStorage(): void {
    // Clear all chat-related localStorage keys for this user
    const index = this.getLocalIndex();
    for (const entry of index) {
      localStorage.removeItem(this.localChatKey(entry.id));
    }
    localStorage.removeItem(this.localIndexKey());
  }
}
