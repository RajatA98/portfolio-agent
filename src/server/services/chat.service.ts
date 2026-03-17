import { encryptForUser, decryptWithFallback } from '../lib/encrypt';
import { getPrisma } from '../lib/prisma';

const MAX_MESSAGES_PER_CHAT = 50;

export interface ChatEntry {
  id: string;
  title: string;
  createdAt: string;
}

export interface ChatMessagePayload {
  role: 'user' | 'assistant';
  content: string;
  confidence?: number;
  warnings?: string[];
}

export class ChatService {
  async listChats(userId: string): Promise<ChatEntry[]> {
    const prisma = getPrisma();
    const chats = await prisma.chat.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, title: true, createdAt: true }
    });
    return chats.map((c) => ({
      id: c.id,
      title: c.title,
      createdAt: c.createdAt.toISOString()
    }));
  }

  async createChat(userId: string, title?: string): Promise<{ id: string }> {
    const prisma = getPrisma();
    const chat = await prisma.chat.create({
      data: { userId, title: title ?? 'New Chat' }
    });
    return { id: chat.id };
  }

  async deleteChat(userId: string, chatId: string): Promise<void> {
    const prisma = getPrisma();
    // Verify ownership then delete (cascade deletes messages)
    await prisma.chat.deleteMany({
      where: { id: chatId, userId }
    });
  }

  async renameChat(userId: string, chatId: string, title: string): Promise<void> {
    const prisma = getPrisma();
    await prisma.chat.updateMany({
      where: { id: chatId, userId },
      data: { title }
    });
  }

  async getMessages(
    userId: string,
    supabaseUserId: string,
    chatId: string
  ): Promise<ChatMessagePayload[]> {
    const prisma = getPrisma();
    // Verify ownership
    const chat = await prisma.chat.findFirst({
      where: { id: chatId, userId }
    });
    if (!chat) return [];

    const rows = await prisma.chatMessage.findMany({
      where: { chatId },
      orderBy: { createdAt: 'asc' }
    });

    return rows.map((row) => {
      const { plaintext: content } = decryptWithFallback(row.contentEncrypted, supabaseUserId);
      let warnings: string[] | undefined;
      if (row.warningsEncrypted) {
        try {
          const { plaintext } = decryptWithFallback(row.warningsEncrypted, supabaseUserId);
          warnings = JSON.parse(plaintext);
        } catch { /* ignore corrupt warnings */ }
      }
      return {
        role: row.role as 'user' | 'assistant',
        content,
        confidence: row.confidence ?? undefined,
        warnings
      };
    });
  }

  async appendMessage(
    userId: string,
    supabaseUserId: string,
    chatId: string,
    message: ChatMessagePayload
  ): Promise<void> {
    const prisma = getPrisma();

    // Verify ownership
    const chat = await prisma.chat.findFirst({
      where: { id: chatId, userId }
    });
    if (!chat) throw new Error('Chat not found');

    const contentEncrypted = encryptForUser(message.content, supabaseUserId);
    const warningsEncrypted = message.warnings?.length
      ? encryptForUser(JSON.stringify(message.warnings), supabaseUserId)
      : null;

    await prisma.chatMessage.create({
      data: {
        chatId,
        role: message.role,
        contentEncrypted,
        confidence: message.confidence ?? null,
        warningsEncrypted
      }
    });

    // Enforce max messages per chat — delete oldest beyond limit
    const count = await prisma.chatMessage.count({ where: { chatId } });
    if (count > MAX_MESSAGES_PER_CHAT) {
      const oldest = await prisma.chatMessage.findMany({
        where: { chatId },
        orderBy: { createdAt: 'asc' },
        take: count - MAX_MESSAGES_PER_CHAT,
        select: { id: true }
      });
      await prisma.chatMessage.deleteMany({
        where: { id: { in: oldest.map((m) => m.id) } }
      });
    }
  }

  async bulkSync(
    userId: string,
    supabaseUserId: string,
    chats: Array<{
      title: string;
      createdAt?: number;
      messages: ChatMessagePayload[];
    }>
  ): Promise<Array<{ localIndex: number; serverId: string }>> {
    const prisma = getPrisma();
    const results: Array<{ localIndex: number; serverId: string }> = [];

    for (let i = 0; i < chats.length; i++) {
      const c = chats[i];
      const chat = await prisma.chat.create({
        data: {
          userId,
          title: c.title,
          createdAt: c.createdAt ? new Date(c.createdAt) : new Date()
        }
      });

      // Encrypt and insert messages
      for (const msg of c.messages.slice(-MAX_MESSAGES_PER_CHAT)) {
        const contentEncrypted = encryptForUser(msg.content, supabaseUserId);
        const warningsEncrypted = msg.warnings?.length
          ? encryptForUser(JSON.stringify(msg.warnings), supabaseUserId)
          : null;

        await prisma.chatMessage.create({
          data: {
            chatId: chat.id,
            role: msg.role,
            contentEncrypted,
            confidence: msg.confidence ?? null,
            warningsEncrypted
          }
        });
      }

      results.push({ localIndex: i, serverId: chat.id });
    }

    return results;
  }
}
