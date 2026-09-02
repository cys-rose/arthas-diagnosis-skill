import { randomUUID } from 'node:crypto';

/** 一条待确认记录。 */
export interface PendingConfirmation {
  token: string;
  pid: number;
  command: string;
  risk: string;
  /** 过期时间戳（ms）。 */
  expiresAt: number;
}

export const CONFIRMATION_TTL_MS = 5 * 60 * 1000;

/**
 * 一次性确认令牌管理：
 * create 签发（绑定 PID + 命令，5 分钟过期）；consume 校验后即销毁，
 * 过期/复用/张冠李戴（不同 PID 或命令）一律拒绝。
 */
export class ConfirmationManager {
  private readonly pending = new Map<string, PendingConfirmation>();

  /** 签发令牌。 */
  create(pid: number, command: string, risk: string, now = Date.now()): PendingConfirmation {
    this.evictExpired(now);
    const confirmation: PendingConfirmation = {
      token: randomUUID(),
      pid,
      command,
      risk,
      expiresAt: now + CONFIRMATION_TTL_MS,
    };
    this.pending.set(confirmation.token, confirmation);
    return confirmation;
  }

  /** 校验并消费令牌（一次性）：成功返回 true，任何不匹配/过期/复用返回 false。 */
  consume(token: string, pid: number, command: string, now = Date.now()): boolean {
    const confirmation = this.pending.get(token);
    if (!confirmation) return false;
    if (confirmation.expiresAt <= now) {
      this.pending.delete(token);
      return false;
    }
    if (confirmation.pid !== pid || confirmation.command !== command) return false;
    this.pending.delete(token);
    return true;
  }

  /** 该 JVM 的待确认数（Dashboard 状态栏展示）。 */
  pendingCount(pid: number, now = Date.now()): number {
    this.evictExpired(now);
    let count = 0;
    for (const c of this.pending.values()) {
      if (c.pid === pid) count++;
    }
    return count;
  }

  private evictExpired(now: number): void {
    for (const [token, c] of this.pending) {
      if (c.expiresAt <= now) this.pending.delete(token);
    }
  }
}
