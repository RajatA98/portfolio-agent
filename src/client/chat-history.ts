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

/**
 * Manages multiple chat conversations per user, stored in localStorage.
 * Each conversation has its own message history.
 */
export class AgentChatHistoryService {
  private messages: AgentChatMessage[] = [];
  private readonly userId: string | undefined;
  private currentChatId: string;

  public constructor(userId?: string) {
    this.userId = userId;

    // Migrate old single-chat history into per-chat format
    this.migrateOldHistory();

    // Load or create the active chat
    const index = this.getIndex();
    if (index.length > 0) {
      this.currentChatId = index[0].id;
    } else {
      this.currentChatId = this.createNewChatEntry();
    }
    this.messages = this.loadMessages();
  }

  // ── Migration ──

  /**
   * Migrate old single-chat history (agentChatHistory_{userId}) into the
   * new per-chat format. Only runs once — removes the old key after migration.
   */
  private migrateOldHistory(): void {
    const oldKey = this.userId
      ? `${AGENT_CHAT_HISTORY_KEY}_${this.userId}`
      : AGENT_CHAT_HISTORY_KEY;

    const oldData = localStorage.getItem(oldKey);
    if (!oldData) return;

    // Check if we already have an index — if so, migration already happened
    const existingIndex = this.getIndex();
    if (existingIndex.length > 0) {
      // Remove old key to prevent re-migration
      localStorage.removeItem(oldKey);
      return;
    }

    try {
      const parsed = JSON.parse(oldData);
      if (!Array.isArray(parsed) || parsed.length === 0) {
        localStorage.removeItem(oldKey);
        return;
      }

      // Create a chat entry for the old history
      const chatId = `chat_migrated_${Date.now()}`;
      const firstUserMsg = parsed.find((m: { role?: string; content?: string }) => m.role === 'user');
      const title = firstUserMsg?.content
        ? (firstUserMsg.content.length > 40 ? firstUserMsg.content.slice(0, 40) + '...' : firstUserMsg.content)
        : 'Previous Chat';

      const entry: ChatEntry = { id: chatId, title, createdAt: Date.now() };
      this.saveIndex([entry]);

      // Save old messages under the new per-chat key
      const newKey = this.chatKey(chatId);
      localStorage.setItem(newKey, oldData);

      // Remove old key
      localStorage.removeItem(oldKey);
    } catch {
      localStorage.removeItem(oldKey);
    }
  }

  // ── Index management ──

  private indexKey(): string {
    return this.userId
      ? `${CHAT_INDEX_KEY}_${this.userId}`
      : CHAT_INDEX_KEY;
  }

  private chatKey(chatId: string): string {
    const base = this.userId
      ? `${AGENT_CHAT_HISTORY_KEY}_${this.userId}`
      : AGENT_CHAT_HISTORY_KEY;
    return `${base}__${chatId}`;
  }

  public getIndex(): ChatEntry[] {
    try {
      const raw = localStorage.getItem(this.indexKey());
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

  private saveIndex(index: ChatEntry[]): void {
    localStorage.setItem(this.indexKey(), JSON.stringify(index));
  }

  /**
   * Create a new chat entry in the index. Returns the chat ID.
   */
  public createNewChatEntry(): string {
    const id = `chat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const entry: ChatEntry = {
      id,
      title: 'New Chat',
      createdAt: Date.now()
    };
    const index = this.getIndex();
    index.unshift(entry); // newest first
    this.saveIndex(index);
    return id;
  }

  /**
   * Switch to an existing chat.
   * Persists current chat messages before switching.
   */
  public switchChat(chatId: string): void {
    // Save current chat first
    this.persistMessages();
    // Switch
    this.currentChatId = chatId;
    this.messages = this.loadMessages();
  }

  /**
   * Create a new chat and switch to it.
   */
  public newChat(): string {
    // Save current chat first
    this.persistMessages();
    // Create and switch
    const id = this.createNewChatEntry();
    this.currentChatId = id;
    this.messages = [];
    return id;
  }

  /**
   * Delete a chat by ID.
   */
  public deleteChat(chatId: string): void {
    const index = this.getIndex().filter((e) => e.id !== chatId);
    this.saveIndex(index);
    localStorage.removeItem(this.chatKey(chatId));

    // If we deleted the active chat, switch to another or create new
    if (chatId === this.currentChatId) {
      if (index.length > 0) {
        this.currentChatId = index[0].id;
        this.messages = this.loadMessages();
      } else {
        const newId = this.createNewChatEntry();
        this.currentChatId = newId;
        this.messages = [];
      }
    }
  }

  /**
   * Rename a chat.
   */
  public renameChat(chatId: string, title: string): void {
    const index = this.getIndex();
    const entry = index.find((e) => e.id === chatId);
    if (entry) {
      entry.title = title;
      this.saveIndex(index);
    }
  }

  public getCurrentChatId(): string {
    return this.currentChatId;
  }

  // ── Message management ──

  public appendAssistantMessage(
    content: string,
    meta?: { confidence?: number; warnings?: string[] }
  ) {
    this.appendMessage({
      confidence: meta?.confidence,
      content,
      role: 'assistant',
      warnings: meta?.warnings
    });
  }

  public appendUserMessage(content: string) {
    this.appendMessage({
      content,
      role: 'user'
    });
    // Auto-title from first user message
    this.autoTitle(content);
  }

  public getMessages(): AgentChatMessage[] {
    return [...this.messages];
  }

  public clear(): void {
    this.messages = [];
    localStorage.removeItem(this.chatKey(this.currentChatId));
  }

  public static removeUnscopedHistory(): void {
    localStorage.removeItem(AGENT_CHAT_HISTORY_KEY);
  }

  private autoTitle(userMessage: string): void {
    const index = this.getIndex();
    const entry = index.find((e) => e.id === this.currentChatId);
    if (entry && entry.title === 'New Chat') {
      entry.title = userMessage.length > 40
        ? userMessage.slice(0, 40) + '...'
        : userMessage;
      this.saveIndex(index);
    }
  }

  private appendMessage(message: AgentChatMessage) {
    this.messages = [...this.messages, message].slice(-MAX_HISTORY_MESSAGES);
    this.persistMessages();
  }

  private loadMessages(): AgentChatMessage[] {
    const rawValue = localStorage.getItem(this.chatKey(this.currentChatId));

    if (!rawValue) return [];

    try {
      const parsed = JSON.parse(rawValue);
      if (!Array.isArray(parsed)) return [];

      return parsed
        .filter((entry: Record<string, unknown>) => {
          return (
            typeof entry?.content === 'string' &&
            (entry?.role === 'assistant' || entry?.role === 'user')
          );
        })
        .map((entry: Record<string, unknown>) => ({
          confidence:
            typeof entry.confidence === 'number' ? entry.confidence : undefined,
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

  private persistMessages() {
    localStorage.setItem(
      this.chatKey(this.currentChatId),
      JSON.stringify(this.messages)
    );
  }
}
