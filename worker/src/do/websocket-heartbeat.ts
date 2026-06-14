/**
 * WebSocket 心跳和连接管理增强
 *
 * 使用说明：
 * 1. 在LiveDataDO中添加心跳检测
 * 2. 定期发送ping消息
 * 3. 超时未响应的连接自动关闭
 */

// 在 LiveDataDO 类中添加以下常量
const WEBSOCKET_PING_INTERVAL_MS = 30_000; // 30秒发送一次ping
const WEBSOCKET_PONG_TIMEOUT_MS = 60_000;  // 60秒未响应则关闭连接

interface SessionHeartbeat {
  lastPingAt: number;
  lastPongAt: number;
  missedPongs: number;
}

/**
 * 在LiveDataDO类中添加心跳管理
 *
 * 添加到类属性：
 * private sessionHeartbeats: Map<string, SessionHeartbeat> = new Map();
 * private heartbeatInterval: number | null = null;
 */

/**
 * 启动心跳检测（在constructor中调用）
 */
function startHeartbeat(this: any) {
  // 每30秒检查一次所有连接
  if (!this.heartbeatInterval) {
    this.heartbeatInterval = setInterval(() => {
      this.checkHeartbeats();
    }, WEBSOCKET_PING_INTERVAL_MS);
  }
}

/**
 * 检查所有连接的心跳状态
 */
function checkHeartbeats(this: any) {
  const now = Date.now();

  for (const [sessionId, ws] of this.sessions.entries()) {
    if (ws.readyState !== 1) { // WebSocket.READY_STATE_OPEN
      this.removeSession(sessionId);
      continue;
    }

    const heartbeat = this.sessionHeartbeats.get(sessionId);

    if (!heartbeat) {
      // 新连接，初始化心跳
      this.sessionHeartbeats.set(sessionId, {
        lastPingAt: now,
        lastPongAt: now,
        missedPongs: 0,
      });
      this.sendPing(ws, sessionId);
      continue;
    }

    // 检查是否超时
    const timeSinceLastPong = now - heartbeat.lastPongAt;
    if (timeSinceLastPong > WEBSOCKET_PONG_TIMEOUT_MS) {
      console.warn(`[live-data] WebSocket session ${sessionId} timeout, closing`);
      ws.close(1000, 'Ping timeout');
      this.removeSession(sessionId);
      continue;
    }

    // 发送ping
    if (now - heartbeat.lastPingAt >= WEBSOCKET_PING_INTERVAL_MS) {
      this.sendPing(ws, sessionId);
      heartbeat.lastPingAt = now;
    }
  }
}

/**
 * 发送ping消息
 */
function sendPing(this: any, ws: any, sessionId: string) {
  try {
    ws.send(JSON.stringify({
      type: 'ping',
      timestamp: Date.now(),
    }));
  } catch (error) {
    console.error(`[live-data] Failed to send ping to ${sessionId}:`, error);
  }
}

/**
 * 处理pong响应（在handleWebSocketMessage中添加）
 */
function handlePong(this: any, sessionId: string) {
  const heartbeat = this.sessionHeartbeats.get(sessionId);
  if (heartbeat) {
    heartbeat.lastPongAt = Date.now();
    heartbeat.missedPongs = 0;
  }
}

/**
 * 清理过期连接（在alarm中定期调用）
 */
function cleanupStaleConnections(this: any) {
  const now = Date.now();
  const staleThreshold = 5 * 60 * 1000; // 5分钟

  for (const [sessionId, ws] of this.sessions.entries()) {
    const heartbeat = this.sessionHeartbeats.get(sessionId);

    if (!heartbeat) continue;

    // 如果超过5分钟没有任何活动，强制关闭
    if (now - heartbeat.lastPongAt > staleThreshold) {
      console.warn(`[live-data] Removing stale session ${sessionId}`);
      ws.close(1000, 'Connection stale');
      this.removeSession(sessionId);
    }
  }
}

/**
 * 清理会话时也清理心跳记录（修改cleanupSession方法）
 */
function enhancedCleanupSession(this: any, sessionId: string) {
  // 原有的清理逻辑...

  // 清理心跳记录
  this.sessionHeartbeats.delete(sessionId);
}

/**
 * 实现说明：
 *
 * 1. 在LiveDataDO的constructor中调用：
 *    this.startHeartbeat();
 *
 * 2. 在WebSocket消息处理中添加pong响应：
 *    if (data.type === 'pong') {
 *      this.handlePong(sessionId);
 *      return;
 *    }
 *
 * 3. 在alarm()方法中定期清理：
 *    this.cleanupStaleConnections();
 *
 * 4. 前端需要响应ping消息：
 *    if (data.type === 'ping') {
 *      ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
 *    }
 */

export {
  WEBSOCKET_PING_INTERVAL_MS,
  WEBSOCKET_PONG_TIMEOUT_MS,
  startHeartbeat,
  checkHeartbeats,
  sendPing,
  handlePong,
  cleanupStaleConnections,
  enhancedCleanupSession,
};
