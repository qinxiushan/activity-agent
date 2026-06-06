/**
 * Opening Hours Service - 场所营业时间校验
 *
 * 解析 "10:00-22:00" 格式的营业时间字符串，
 * 判定指定 datetime 是否在营业窗口内。
 *
 * 支持周内差异化（如博物馆周一闭馆）。
 */

export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface OpeningHours {
  /** 周一到周日的营业时间。null = 当日闭馆。 */
  schedule: Array<{ open: string; close: string } | null>;
  /** 简短描述（"10:00-22:00" / "周一闭馆"） */
  summary: string;
}

export interface OpeningCheck {
  open: boolean;
  weekday: Weekday;
  hoursToday: string | null;
  reason: string;
  nextOpenAt?: string;
}

const TIME_RE = /^(\d{1,2}):(\d{2})$/;

function parseHHMM(s: string): number {
  const m = TIME_RE.exec(s);
  if (!m) throw new Error(`Invalid time format: ${s}`);
  return parseInt(m[1]!, 10) * 60 + parseInt(m[2]!, 10);
}

function toMinutes(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

function weekdayCN(d: Weekday): string {
  return ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d]!;
}

export function isOpenAt(hours: OpeningHours, when: Date): OpeningCheck {
  const jsDay = when.getDay();
  const wd = (jsDay === 0 ? 6 : jsDay - 1) as Weekday;
  const slot = hours.schedule[wd];
  if (!slot) {
    return {
      open: false,
      weekday: wd,
      hoursToday: null,
      reason: `${weekdayCN(wd)}闭馆`,
    };
  }
  const now = toMinutes(when);
  const open = parseHHMM(slot.open);
  const close = parseHHMM(slot.close);
  const within = now >= open && now <= close;
  return {
    open: within,
    weekday: wd,
    hoursToday: `${slot.open}-${slot.close}`,
    reason: within ? "营业中" : now < open ? `未开门（${slot.open} 开始）` : `已闭店（${slot.close} 结束）`,
  };
}

export function parseHoursString(s: string): OpeningHours {
  const parts = s.split(",").map((p) => p.trim());
  const schedule: OpeningHours["schedule"] = [null, null, null, null, null, null, null];
  let allSame = true;
  let firstValid: { open: string; close: string } | null = null;

  if (parts.length === 1) {
    const p = parts[0]!;
    if (p === "-" || p === "闭" || p === "闭馆") {
      return { schedule, summary: "闭馆" };
    }
    const m = p.match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
    if (!m) throw new Error(`Invalid hours segment: ${p}`);
    const slot = { open: m[1]!, close: m[2]! };
    for (let i = 0; i < 7; i++) schedule[i] = slot;
    return { schedule, summary: `${slot.open}-${slot.close}` };
  }

  for (let i = 0; i < parts.length && i < 7; i++) {
    const p = parts[i]!;
    if (p === "-" || p === "闭" || p === "闭馆") {
      schedule[i] = null;
    } else {
      const m = p.match(/^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
      if (!m) throw new Error(`Invalid hours segment: ${p}`);
      schedule[i] = { open: m[1]!, close: m[2]! };
      if (firstValid === null) firstValid = schedule[i]!;
      if (i > 0 && schedule[i - 1] && schedule[i] &&
        (schedule[i - 1] as { open: string; close: string }).open !== schedule[i]!.open) {
        allSame = false;
      }
    }
  }
  const summary = allSame && firstValid ? `${firstValid.open}-${firstValid.close}` : s;
  return { schedule, summary };
}
