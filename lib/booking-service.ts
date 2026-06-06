/**
 * Booking Service - 餐厅预订订单状态机
 *
 * 解决问题（PRD P0-2）：
 * - 当前 reservation_exec 是假订单号 `ORD-${Date.now()}`
 * - 没有状态生命周期：pending → confirmed/failed/notified
 * - 没有持久化：刷新页面就丢
 * - 没有通知：用户不知道预订成功/失败
 * - "全流程自动执行"完全是 mock
 *
 * 设计：
 * - 状态机：pending → processing → (confirmed | failed) → notified
 * - 持久化：JSON 文件存储（无需 SQLite 依赖）
 * - 模拟异步处理：setTimeout 模拟外部预订 API 延迟
 * - 模拟失败率：可配置（默认 10%）用于演示容错
 * - 通知：写入会话文件 + 控制台日志（生产可换 webhook/邮件）
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { getPOIById } from "./poi-database";

// ─── 类型定义 ──────────────────────────────────────────────────────

export type OrderStatus =
  | "pending"      // 订单创建
  | "processing"   // 正在调外部预订 API
  | "confirmed"    // 预订成功
  | "failed"       // 预订失败
  | "notified";    // 已通知用户

export interface BookingOrder {
  orderId: string;
  status: OrderStatus;
  restaurantId: string;
  restaurantName: string;
  date: string;          // YYYY-MM-DD
  time: string;          // HH:MM
  partySize: number;
  specialRequests?: string;
  userId: string;        // 关联到 session
  createdAt: number;
  updatedAt: number;
  confirmedAt?: number;
  failureReason?: string;
  confirmationCode?: string;
  retryCount: number;
}

export interface CreateBookingInput {
  restaurantId: string;
  restaurantName: string;
  date: string;
  time: string;
  partySize: number;
  specialRequests?: string;
  userId: string;
}

export interface BookingServiceConfig {
  /** 模拟外部 API 延迟（ms） */
  processingDelayMs: number;
  /** 模拟失败率（0-1） */
  failureRate: number;
  /** 持久化目录（默认 ~/.pi/agent/bookings） */
  storageDir?: string;
}

// ─── 默认配置 ──────────────────────────────────────────────────────

const DEFAULT_CONFIG: BookingServiceConfig = {
  processingDelayMs: 800,
  failureRate: 0.1,
};

// ─── BookingService 类 ─────────────────────────────────────────────

export class BookingService {
  private readonly storageDir: string;
  private readonly config: BookingServiceConfig;
  /** 内存缓存：orderId → Order */
  private readonly cache = new Map<string, BookingOrder>();
  private initPromise: Promise<void> | null = null;

  constructor(config: Partial<BookingServiceConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.storageDir = this.config.storageDir ?? path.join(os.homedir(), ".pi", "agent", "bookings");
  }

  private async ensureInit(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        await fs.mkdir(this.storageDir, { recursive: true });
        // 加载已有订单
        try {
          const files = await fs.readdir(this.storageDir);
          for (const f of files.filter((f) => f.endsWith(".json"))) {
            const content = await fs.readFile(path.join(this.storageDir, f), "utf-8");
            const order = JSON.parse(content) as BookingOrder;
            this.cache.set(order.orderId, order);
          }
        } catch {
          // 首次启动，目录为空
        }
      })();
    }
    return this.initPromise;
  }

  // ─── 创建订单 ────────────────────────────────────────────────

  async createBooking(input: CreateBookingInput): Promise<BookingOrder> {
    await this.ensureInit();

    // 1. 校验餐厅存在
    const poi = getPOIById(input.restaurantId);
    if (!poi) {
      throw new BookingError("RESTAURANT_NOT_FOUND", `Restaurant ${input.restaurantId} not found`);
    }
    if (poi.category !== "dining") {
      throw new BookingError("INVALID_RESTAURANT", `${input.restaurantId} is not a restaurant`);
    }

    // 2. 校验日期/时间
    this.validateDateTime(input.date, input.time);

    // 3. 校验人数
    if (input.partySize < 1 || input.partySize > 20) {
      throw new BookingError("INVALID_PARTY_SIZE", `partySize must be 1-20, got ${input.partySize}`);
    }

    // 4. 创建订单
    const now = Date.now();
    const order: BookingOrder = {
      orderId: this.generateOrderId(),
      status: "pending",
      ...input,
      createdAt: now,
      updatedAt: now,
      retryCount: 0,
    };

    this.cache.set(order.orderId, order);
    await this.persist(order);

    // 5. 触发异步处理
    this.processOrder(order.orderId).catch((e) => {
      console.error(`[BookingService] async process error for ${order.orderId}:`, e);
    });

    return order;
  }

  // ─── 异步处理（模拟外部 API） ────────────────────────────────

  private async processOrder(orderId: string): Promise<void> {
    const order = this.cache.get(orderId);
    if (!order) return;

    // pending → processing
    order.status = "processing";
    order.updatedAt = Date.now();
    await this.persist(order);

    // 模拟外部 API 延迟
    await new Promise((r) => setTimeout(r, this.config.processingDelayMs));

    // 模拟成功/失败
    const success = Math.random() > this.config.failureRate;

    if (success) {
      order.status = "confirmed";
      order.confirmedAt = Date.now();
      order.confirmationCode = this.generateConfirmationCode();
      order.updatedAt = Date.now();
    } else {
      order.status = "failed";
      order.failureReason = this.pickFailureReason();
      order.retryCount++;
      order.updatedAt = Date.now();
    }

    await this.persist(order);

    // 模拟通知
    await this.notifyUser(order);
  }

  private pickFailureReason(): string {
    const reasons = [
      "餐厅已满，请尝试其他时段",
      "餐厅当日已停止接受预订",
      "网络异常，预订未送达",
      "支付授权失败（演示）",
    ];
    return reasons[Math.floor(Math.random() * reasons.length)] ?? reasons[0]!;
  }

  // ─── 通知（mock：写日志 + 持久化到 notification 文件） ─────────

  private async notifyUser(order: BookingOrder): Promise<void> {
    // 通知 = 把状态标记为 notified
    order.status = "notified";
    order.updatedAt = Date.now();
    await this.persist(order);

    // 真实场景：发邮件/短信/推送
    const msg =
      order.status === "notified" && order.confirmationCode
        ? `[预订成功] ${order.restaurantName} ${order.date} ${order.time} 确认码 ${order.confirmationCode}`
        : `[预订失败] ${order.restaurantName} ${order.failureReason}`;
    console.log(`[BookingService] ${msg}`);
  }

  // ─── 查询 ────────────────────────────────────────────────────

  async getOrder(orderId: string): Promise<BookingOrder | undefined> {
    await this.ensureInit();
    return this.cache.get(orderId);
  }

  async getOrdersByUser(userId: string): Promise<BookingOrder[]> {
    await this.ensureInit();
    return Array.from(this.cache.values())
      .filter((o) => o.userId === userId)
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async getActiveOrders(userId: string): Promise<BookingOrder[]> {
    await this.ensureInit();
    return Array.from(this.cache.values())
      .filter((o) => o.userId === userId && (o.status === "pending" || o.status === "processing"))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  // ─── 重试失败订单 ───────────────────────────────────────────

  async retryOrder(orderId: string): Promise<BookingOrder> {
    await this.ensureInit();
    const order = this.cache.get(orderId);
    if (!order) throw new BookingError("ORDER_NOT_FOUND", `Order ${orderId} not found`);
    if (order.status !== "failed") {
      throw new BookingError("INVALID_STATE", `Can only retry failed orders, current: ${order.status}`);
    }

    order.status = "pending";
    order.failureReason = undefined;
    order.updatedAt = Date.now();
    await this.persist(order);

    this.processOrder(orderId).catch((e) => {
      console.error(`[BookingService] retry error for ${orderId}:`, e);
    });

    return order;
  }

  // ─── 持久化 ──────────────────────────────────────────────────

  private async persist(order: BookingOrder): Promise<void> {
    const file = path.join(this.storageDir, `${order.orderId}.json`);
    await fs.writeFile(file, JSON.stringify(order, null, 2), "utf-8");
  }

  // ─── 工具方法 ────────────────────────────────────────────────

  private generateOrderId(): string {
    return `ORD-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
  }

  private generateConfirmationCode(): string {
    return Math.random().toString(36).slice(2, 8).toUpperCase();
  }

  private validateDateTime(date: string, time: string): void {
    // 校验 YYYY-MM-DD
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new BookingError("INVALID_DATE", `date must be YYYY-MM-DD, got ${date}`);
    }
    // 校验 HH:MM
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
      throw new BookingError("INVALID_TIME", `time must be HH:MM, got ${time}`);
    }
    // 校验日期不能是过去
    const [y, m, d] = date.split("-").map(Number);
    const bookingDate = new Date(y!, m! - 1, d!);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (bookingDate < today) {
      throw new BookingError("PAST_DATE", `Cannot book a past date: ${date}`);
    }
  }
}

// ─── 错误类 ────────────────────────────────────────────────────────

export class BookingError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "BookingError";
  }
}

// ─── 单例（与 session 关联） ──────────────────────────────────────

let _instance: BookingService | null = null;

export function getBookingService(): BookingService {
  if (!_instance) _instance = new BookingService();
  return _instance;
}

// ─── 工具函数：把 BookingOrder 转为工具返回格式 ─────────────────────

export function formatBookingForTool(order: BookingOrder) {
  return {
    orderId: order.orderId,
    status: order.status,
    restaurantName: order.restaurantName,
    date: order.date,
    time: order.time,
    partySize: order.partySize,
    confirmationCode: order.confirmationCode,
    failureReason: order.failureReason,
    createdAt: new Date(order.createdAt).toISOString(),
    confirmedAt: order.confirmedAt ? new Date(order.confirmedAt).toISOString() : undefined,
  };
}
