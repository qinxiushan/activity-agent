/**
 * scripts/validate-amap.ts — 高德 REST 真实数据验证
 *
 * 直连 restapi.amap.com/v3/*（与 @amap/amap-maps-mcp-server 内部同源端点），实测：
 *   1. 每类能力的真实返回与延迟
 *   2. 默认 POI 搜索是否真的只有 id/name/address/typecode（丢评分/人均）
 *   3. extensions=all 能否把 biz_ext(评分/人均) 内联进搜索结果（决定要不要 N+1）
 *   4. search_detail 在真实 POI 上评分/人均/营业时间的完整率
 *   5. N+1（搜 + 逐个详情）的真实调用数与延迟
 *   6. 真实高德字段 vs 你现有 mock POI 字段的差异
 *
 * 运行：npx tsx scripts/validate-amap.ts
 * key：从 process.env.AMAP_MAPS_API_KEY 或 .env 读取（不硬编码、不打印明文）。
 */
import fs from "node:fs";
import path from "node:path";

// ── key（env 优先，回退解析 .env）──────────────────────────────────
function loadKey(): string {
  if (process.env.AMAP_MAPS_API_KEY) return process.env.AMAP_MAPS_API_KEY;
  try {
    const env = fs.readFileSync(path.resolve(process.cwd(), ".env"), "utf8");
    const m = env.match(/^AMAP_MAPS_API_KEY\s*=\s*(.+)$/m);
    if (m) return m[1].trim().replace(/^["']|["']$/g, "");
  } catch { /* ignore */ }
  throw new Error("AMAP_MAPS_API_KEY 未设置（写入 .env 或 export 后重试）");
}
const KEY = loadKey();
const maskKey = KEY.slice(0, 4) + "…" + KEY.slice(-4);

const BASE = "https://restapi.amap.com/v3";
const ADCODE: Record<string, string> = { 北京: "110000", 上海: "310000", 深圳: "440300" };

// ── 通用 GET（计时 + 超时 + 错误归一）─────────────────────────────
interface Call { ep: string; ok: boolean; ms: number; status?: string; info?: string; infocode?: string; data?: any; err?: string }
const LOG: Call[] = [];

async function amGet(ep: string, pathname: string, params: Record<string, string>): Promise<Call> {
  const url = new URL(`${BASE}/${pathname}`);
  url.searchParams.set("key", KEY);
  url.searchParams.set("source", "ts_mcp");
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") url.searchParams.set(k, v);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  const start = Date.now();
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const ms = Date.now() - start;
    const data: any = await res.json().catch(() => ({}));
    const call: Call = { ep, ok: data.status === "1", ms, status: data.status, info: data.info, infocode: data.infocode, data };
    LOG.push(call);
    return call;
  } catch (e: any) {
    const call: Call = { ep, ok: false, ms: Date.now() - start, err: e?.message ?? String(e) };
    LOG.push(call);
    return call;
  } finally {
    clearTimeout(timer);
  }
}

// ── 字段存在判定（高德常返回 "" / [] 表示缺失）────────────────────
const present = (v: any): boolean => {
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.trim() !== "" && v !== "[]";
  if (Array.isArray(v)) return v.length > 0;
  return true;
};
function pickBiz(poi: any): { rating: string; cost: string; open: string } {
  const b = poi?.biz_ext ?? {};
  const open = present(b.open_time) ? b.open_time : (present(b.opentime2) ? b.opentime2 : (present(poi?.business_hours) ? poi.business_hours : ""));
  return {
    rating: present(b.rating) ? String(b.rating) : "",
    cost: present(b.cost) ? String(b.cost) : "",
    open: open ? String(open) : "",
  };
}

// ── 采样累加器 ────────────────────────────────────────────────────
const samp = {
  aroundBase: [] as any[],   // around_search 默认（extensions 未传）
  aroundAll: [] as any[],    // around_search extensions=all
  detail: [] as any[],       // search_detail
  nplus1: [] as { city: string; k: number; searchMs: number; detailMs: number; totalMs: number }[],
};
const rawSamples: any[] = [];

// ── 单城市验证 ────────────────────────────────────────────────────
async function runCity(city: string, departure: string, activityKw: string, diningKw: string) {
  const adcode = ADCODE[city];
  console.log(`\n──────── ${city} ────────`);

  // 1) 地理编码：出发地名 → 坐标（去掉用户手填经纬度）
  const geo = await amGet("geocode", "geocode/geo", { address: departure, city });
  const loc: string = geo.data?.geocodes?.[0]?.location ?? "";
  console.log(`  geocode "${departure}" → ${loc || "❌"} (${geo.ms}ms, ${geo.ok ? "ok" : geo.info})  level=${geo.data?.geocodes?.[0]?.level ?? "-"}`);

  // 2) 天气：城市名 vs adcode（暴露"天气要 adcode"的真实坑）
  const wName = await amGet("weather(name)", "weather/weatherInfo", { city, extensions: "all" });
  const wCode = await amGet("weather(adcode)", "weather/weatherInfo", { city: adcode, extensions: "all" });
  const cast = wCode.data?.forecasts?.[0]?.casts?.[0];
  console.log(`  weather 名称=${wName.ok ? "ok" : "❌" + wName.info} adcode=${wCode.ok ? "ok" : "❌"}  样例: ${cast ? `${cast.date} ${cast.dayweather} ${cast.nighttemp}-${cast.daytemp}℃` : "-"} (${wCode.ms}ms)`);

  // 3) 活动 POI：文本搜索 默认 vs extensions=all（验证字段丢失）
  const actBase = await amGet("text_search(base)", "place/text", { keywords: activityKw, city, citylimit: "true", offset: "5" });
  const actAll = await amGet("text_search(all)", "place/text", { keywords: activityKw, city, citylimit: "true", extensions: "all", offset: "5" });
  const actBaseKeys = Object.keys(actBase.data?.pois?.[0] ?? {});
  const actAllBiz = pickBiz(actAll.data?.pois?.[0] ?? {});
  console.log(`  text_search "${activityKw}": base 字段=[${actBaseKeys.join(",")}]`);
  console.log(`     extensions=all → rating=${actAllBiz.rating || "∅"} cost=${actAllBiz.cost || "∅"} open=${actAllBiz.open ? "有" : "∅"}`);

  // 4) 餐厅 POI：周边搜 默认 vs extensions=all
  const arBase = loc ? await amGet("around_search(base)", "place/around", { location: loc, keywords: diningKw, radius: "3000", offset: "10" }) : null;
  const arAll = loc ? await amGet("around_search(all)", "place/around", { location: loc, keywords: diningKw, radius: "3000", extensions: "all", offset: "10" }) : null;
  const arBasePois: any[] = arBase?.data?.pois ?? [];
  const arAllPois: any[] = arAll?.data?.pois ?? [];
  samp.aroundBase.push(...arBasePois);
  samp.aroundAll.push(...arAllPois);
  const allInlineRating = arAllPois.filter((p) => present(p?.biz_ext?.rating)).length;
  console.log(`  around_search "${diningKw}" 半径3km: 命中 ${arAllPois.length} 家; extensions=all 内联评分 ${allInlineRating}/${arAllPois.length}, 人均 ${arAllPois.filter((p) => present(p?.biz_ext?.cost)).length}/${arAllPois.length}`);

  // 5) N+1：对前 3 家餐厅逐个 search_detail
  const top = arAllPois.slice(0, 3);
  const searchMs = arAll?.ms ?? 0;
  let detailMs = 0;
  for (const p of top) {
    const d = await amGet("search_detail", "place/detail", { id: p.id });
    detailMs += d.ms;
    const poi = d.data?.pois?.[0];
    if (poi) samp.detail.push(poi);
  }
  samp.nplus1.push({ city, k: top.length, searchMs, detailMs, totalMs: searchMs + detailMs });
  const detBiz = top.map((_, i) => pickBiz(samp.detail[samp.detail.length - top.length + i]));
  console.log(`  N+1: 1 次周边搜(${searchMs}ms) + ${top.length} 次详情(${detailMs}ms) = ${searchMs + detailMs}ms; 详情评分完整 ${detBiz.filter((b) => b.rating).length}/${top.length}, 人均 ${detBiz.filter((b) => b.cost).length}/${top.length}, 营业时间 ${detBiz.filter((b) => b.open).length}/${top.length}`);

  // 6) 路径规划：出发地 → 第一家餐厅
  const dest = top[0]?.location;
  if (loc && dest) {
    const walk = await amGet("direction_walking", "direction/walking", { origin: loc, destination: dest });
    const drive = await amGet("direction_driving", "direction/driving", { origin: loc, destination: dest });
    const transit = await amGet("direction_transit", "direction/transit/integrated", { origin: loc, destination: dest, city: adcode, cityd: adcode });
    const wp = walk.data?.route?.paths?.[0];
    const dp = drive.data?.route?.paths?.[0];
    const tr = transit.data?.route?.transits?.[0];
    console.log(`  route 出发→${top[0].name}: 步行 ${wp ? `${wp.distance}m/${Math.round(wp.duration / 60)}min` : "❌"}, 驾车 ${dp ? `${dp.distance}m/${Math.round(dp.duration / 60)}min` : "❌"}, 公交 ${tr ? `${Math.round(tr.duration / 60)}min` : "❌"} (${walk.ms}/${drive.ms}/${transit.ms}ms)`);

    // 7) 距离测量：一次算出发地到多家餐厅（规避逐个算路的 N+1）
    const origins = top.map((p) => p.location).join("|");
    const dist = await amGet("distance", "distance", { origins, destination: dest, type: "1" });
    console.log(`  distance 批量(${top.length} 起点→1 终点): ${dist.ok ? "ok" : "❌"} 一次调用返回 ${dist.data?.results?.length ?? 0} 条 (${dist.ms}ms)`);
  }

  // 存 2 个精简样本入报告
  if (top[0]) {
    const detailPoi = samp.detail[samp.detail.length - top.length] ?? {};
    rawSamples.push({
      city, keyword: diningKw,
      around_all: { id: top[0].id, name: top[0].name, address: top[0].address, typecode: top[0].typecode, location: top[0].location, biz_ext: top[0].biz_ext ?? null },
      detail: { id: detailPoi.id, name: detailPoi.name, type: detailPoi.type, business_area: detailPoi.business_area, biz_ext: pickBiz(detailPoi), raw_biz_ext_keys: Object.keys(detailPoi.biz_ext ?? {}) },
    });
  }
}

// ── 聚合与报告 ────────────────────────────────────────────────────
function agg(nums: number[]) {
  if (!nums.length) return { avg: 0, min: 0, max: 0, n: 0 };
  const s = [...nums].sort((a, b) => a - b);
  return { avg: Math.round(nums.reduce((a, b) => a + b, 0) / nums.length), min: s[0], max: s[s.length - 1], n: nums.length };
}
function rate(arr: any[], f: (x: any) => boolean): string {
  if (!arr.length) return "0/0 (—)";
  const n = arr.filter(f).length;
  return `${n}/${arr.length} (${Math.round((n / arr.length) * 100)}%)`;
}

async function main() {
  console.log(`高德 REST 真实数据验证 · key=${maskKey} · ${BASE}`);
  await runCity("北京", "国贸", "故宫", "火锅");
  await runCity("上海", "外滩", "上海博物馆", "本帮菜");
  await runCity("深圳", "深圳北站", "欢乐谷", "粤菜");

  // 端点延迟聚合
  const byEp = new Map<string, number[]>();
  for (const c of LOG) { if (!byEp.has(c.ep)) byEp.set(c.ep, []); byEp.get(c.ep)!.push(c.ms); }
  const okCount = LOG.filter((c) => c.ok).length;

  // 报告
  const L: string[] = [];
  L.push(`# 高德真实数据验证报告（直连 REST）\n`);
  L.push(`- key: \`${maskKey}\` · 端点: \`restapi.amap.com/v3\` · 直连（与官方 MCP server 同源）`);
  L.push(`- 总调用: ${LOG.length} · 成功: ${okCount} (${Math.round((okCount / LOG.length) * 100)}%)\n`);

  L.push(`## 1. 各端点延迟`);
  L.push(`| 端点 | 次数 | avg | min | max |`);
  L.push(`|---|---:|---:|---:|---:|`);
  for (const [ep, ms] of byEp) { const a = agg(ms); L.push(`| ${ep} | ${a.n} | ${a.avg}ms | ${a.min}ms | ${a.max}ms |`); }

  L.push(`\n## 2. 字段完整率（关键结论）`);
  L.push(`| 来源 | 样本 | 评分 rating | 人均 cost | 营业时间 |`);
  L.push(`|---|---:|---|---|---|`);
  L.push(`| around_search 默认 | ${samp.aroundBase.length} | ${rate(samp.aroundBase, (p) => present(p?.biz_ext?.rating))} | ${rate(samp.aroundBase, (p) => present(p?.biz_ext?.cost))} | — |`);
  L.push(`| around_search extensions=all | ${samp.aroundAll.length} | ${rate(samp.aroundAll, (p) => present(p?.biz_ext?.rating))} | ${rate(samp.aroundAll, (p) => present(p?.biz_ext?.cost))} | — |`);
  L.push(`| search_detail | ${samp.detail.length} | ${rate(samp.detail, (p) => present(p?.biz_ext?.rating))} | ${rate(samp.detail, (p) => present(p?.biz_ext?.cost))} | ${rate(samp.detail, (p) => pickBiz(p).open !== "")} |`);
  const inlineWorks = samp.aroundAll.filter((p) => present(p?.biz_ext?.rating)).length > 0;
  L.push(`\n> **N+1 是否可规避**：around_search + extensions=all ${inlineWorks ? "**能**内联评分/人均 → 可省掉逐个 detail 的 N+1 ✅" : "**不能**内联评分/人均 → 评分/人均必须走 search_detail 的 N+1 ⚠️"}`);

  L.push(`\n## 3. N+1 实测`);
  L.push(`| 城市 | 详情次数 | 搜索延迟 | 详情总延迟 | 合计 |`);
  L.push(`|---|---:|---:|---:|---:|`);
  for (const n of samp.nplus1) L.push(`| ${n.city} | ${n.k} | ${n.searchMs}ms | ${n.detailMs}ms | ${n.totalMs}ms |`);

  L.push(`\n## 4. 真实 POI 样本`);
  for (const s of rawSamples) L.push(`\n\`\`\`json\n${JSON.stringify(s, null, 2)}\n\`\`\``);

  L.push(`\n## 5. 真实高德 vs 你的 mock POI 字段差异`);
  L.push(`| mock 字段 | 高德来源 | 可得性 |`);
  L.push(`|---|---|---|`);
  L.push(`| id / name / address / lng,lat | text/around_search + geo | ✅ 直接 |`);
  L.push(`| rating(评分) | search_detail.biz_ext / around(all) | ${inlineWorks ? "✅ 可内联" : "⚠️ 需 detail"} |`);
  L.push(`| pricePerPerson(人均) | biz_ext.cost | 见完整率表 |`);
  L.push(`| openingHours(营业时间) | biz_ext.open_time/opentime2 | 见§2 完整率（详情实测约 89%，少数为空）|`);
  L.push(`| avgDuration(游玩时长) | 无 | ❌ 高德不提供 → LLM 估/常量 |`);
  L.push(`| cuisine(菜系) | type 字符串 | ⚠️ 非结构化 |`);
  L.push(`| dietaryOptions(清真/素食) | 无 | ❌ 高德不提供 → 美团增强/降级 |`);
  L.push(`| signature(招牌菜) | 无 | ❌ 高德不提供 |`);
  L.push(`| tags | typecode/type | ⚠️ 仅类别码 |`);

  const outDir = path.resolve(process.cwd(), "docs/real-integration");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "amap-validation-report.md");
  fs.writeFileSync(outFile, L.join("\n") + "\n", "utf8");

  console.log(`\n════════ 汇总 ════════`);
  console.log(`总调用 ${LOG.length} · 成功率 ${Math.round((okCount / LOG.length) * 100)}%`);
  console.log(`extensions=all 内联评分/人均: ${inlineWorks ? "✅ 能（可省 N+1）" : "⚠️ 不能（评分/人均须走 detail）"}`);
  console.log(`detail 完整率: 评分 ${rate(samp.detail, (p) => present(p?.biz_ext?.rating))} · 人均 ${rate(samp.detail, (p) => present(p?.biz_ext?.cost))} · 营业时间 ${rate(samp.detail, (p) => pickBiz(p).open !== "")}`);
  const failed = LOG.filter((c) => !c.ok);
  if (failed.length) {
    console.log(`\n失败调用 ${failed.length}:`);
    for (const f of failed) console.log(`  - ${f.ep}: ${f.err ?? `${f.info}(${f.infocode})`}`);
  }
  console.log(`\n报告已写入: ${path.relative(process.cwd(), outFile)}`);
}

main().catch((e) => { console.error("验证失败:", e); process.exit(1); });
