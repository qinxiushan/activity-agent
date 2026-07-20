/**
 * 幂等键测试（route-B 改动 5）——同身份两次下单返回同一订单。
 * 跑法：npx tsx scripts/idempotency-test.ts
 */

import { BookingService } from "../lib/booking-service";

let pass = 0;
let fail = 0;
const assert = (c: boolean, m: string): void => { if (c) { pass++; } else { fail++; console.error(`❌ ${m}`); } };

const svc = new BookingService({ processingDelayMs: 10, failureRate: 0 });
const input = {
  restaurantId: "bj-r-002",
  restaurantName: "测试餐厅",
  date: "2026-12-25",
  time: "18:30",
  partySize: 2,
  userId: "idem-test-user",
};

async function main(): Promise<void> {
  const o1 = await svc.createBooking(input);
  const o2 = await svc.createBooking(input); // 同身份 → 应返回同一订单
  assert(o1.orderId === o2.orderId, `★幂等：同身份两次下单返回同一 orderId（${o1.orderId} vs ${o2.orderId}）`);
  assert(typeof o1.idempotencyKey === "string" && o1.idempotencyKey.length > 0, "订单带 idempotencyKey");

  const o3 = await svc.createBooking({ ...input, partySize: 4 }); // 不同人数 → 不同订单
  assert(o3.orderId !== o1.orderId, "不同订单身份（人数变）→ 不同 orderId");

  console.log(`\nidempotency-test: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

void main();

