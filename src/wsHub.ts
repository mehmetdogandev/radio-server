import type { WebSocket } from 'ws';

export type WsClient = { 
  socket: WebSocket; 
  userId: number; 
  subs: Set<number>;
  lastPing: number;
  pingInterval?: ReturnType<typeof setInterval>;
};

const PING_INTERVAL = 30000; // 30 seconds
const TIMEOUT_THRESHOLD = 90000; // 90 seconds

export class WsHub {
  private clients = new Set<WsClient>();
  private safeSend(c: WsClient, data: string): void {
    if (c.socket.readyState !== 1) {
      return;
    }
    try {
      c.socket.send(data);
    } catch (e) {
      console.warn('[ws] send_failed', {
        userId: c.userId,
        subsCount: c.subs.size,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  add(c: WsClient): void {
    this.clients.add(c);
    this.setupHeartbeat(c);
  }

  remove(c: WsClient): void {
    if (c.pingInterval) {
      clearInterval(c.pingInterval);
    }
    this.clients.delete(c);
  }

  private setupHeartbeat(c: WsClient): void {
    c.lastPing = Date.now();
    
    // Send ping every 30 seconds
    c.pingInterval = setInterval(() => {
      const now = Date.now();
      const timeSinceLastPing = now - c.lastPing;
      
      // If no pong received in 90 seconds, close connection
      if (timeSinceLastPing > TIMEOUT_THRESHOLD) {
        console.log(`WebSocket timeout for user ${c.userId}, closing connection`);
        c.socket.close();
        this.remove(c);
        return;
      }
      
      // Send ping
      if (c.socket.readyState === 1) {
        c.socket.ping();
      }
    }, PING_INTERVAL);
    
    // Update lastPing when pong received
    c.socket.on('pong', () => {
      c.lastPing = Date.now();
    });
  }

  /** Yeni mesaj — ilgili sohbete abone olanlara (ve gönderene) iletir. */
  broadcastChatMessage(chatId: number, payload: unknown): void {
    const data = JSON.stringify({ type: 'chat:message', chatId, payload });
    for (const c of this.clients) {
      if (c.subs.has(chatId)) {
        this.safeSend(c, data);
      }
    }
  }

  broadcastAck(chatId: number, payload: unknown): void {
    const data = JSON.stringify({ type: 'chat:ack', chatId, payload });
    for (const c of this.clients) {
      if (c.subs.has(chatId)) {
        this.safeSend(c, data);
      }
    }
  }

  broadcastToUser(userId: number, type: string, payload: unknown): void {
    const data = JSON.stringify({ type, payload });
    for (const c of this.clients) {
      if (c.userId === userId) {
        this.safeSend(c, data);
      }
    }
  }

  broadcastEvent(type: string, payload: unknown): void {
    const data = JSON.stringify({ type, payload });
    for (const c of this.clients) {
      this.safeSend(c, data);
    }
  }
}
