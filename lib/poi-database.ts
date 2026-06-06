/**
 * POI Database - 活动/餐厅本地数据源
 *
 * 解决问题（PRD P0-1）：
 * - 当前 activity_search / restaurant_search 完全依赖 LLM 预训练知识
 * - LLM 可能推荐已关闭/不存在的地点，编造价格/评分
 * - 没有真实数据源 = 业务方案不可信
 *
 * 设计：
 * - 内置北京/上海/深圳 3 城各 12 个真实 POI（活动 + 餐厅）
 * - 支持按 location + category + radius (Haversine 距离) 查询
 * - 支持按 budget / dietary / rating 过滤
 * - 返回相关性评分（距离 + 评分 + 价格匹配度）
 * - 数据从 JSON 加载，可热替换为外部 API（保留接口兼容）
 *
 * 注意：
 * - 数据为演示用，参考大众点评/小红书公开信息
 * - Demo 阶段：内存 Map + 启动时加载
 * - Prod 阶段：替换 query() 实现为外部 API 调用即可
 */

// ─── 类型定义 ──────────────────────────────────────────────────────

export type Category = "outdoor" | "cultural" | "shopping" | "entertainment" | "dining";

export type Cuisine =
  | "chinese"
  | "sichuan"
  | "cantonese"
  | "japanese"
  | "western"
  | "korean"
  | "hotpot"
  | "cafe"
  | "bbq"
  | "vegetarian";

export interface POIBase {
  id: string;
  name: string;
  city: string;
  district: string;
  /** 经度 */
  lng: number;
  /** 纬度 */
  lat: number;
  /** 评分 0-5 */
  rating: number;
  /** 人均价格（元） */
  pricePerPerson: number;
  /** 预计停留时长（小时） */
  avgDuration: number;
  /** 标签 */
  tags: string[];
  /** 简短描述 */
  description: string;
  /**
   * 营业时间字符串。
   * 格式：7 段以逗号分隔，每段形如 "10:00-22:00" 或 "-"（闭馆）。
   * 顺序：周一,周二,周三,周四,周五,周六,周日
   * 简化：7 段相同可只写 1 段。
   * 例："09:00-18:00"  表示每天 9-18 点
   * 例："-,-,-,-,-,10:00-22:00,10:00-22:00"  表示工作日闭馆，周末 10-22
   */
  openingHours: string;
}

export interface ActivityPOI extends POIBase {
  category: Exclude<Category, "dining">;
}

export interface RestaurantPOI extends POIBase {
  category: "dining";
  cuisine: Cuisine;
  dietaryOptions: Array<"vegetarian" | "halal" | "low-carb" | "gluten-free" | "spicy">;
  signature: string[];
}

export type POI = ActivityPOI | RestaurantPOI;

export interface POIQuery {
  city: string;
  /** 可选：行政区（朝阳/海淀/徐汇） */
  district?: string;
  /** 可选：POI 类别 */
  category?: Category;
  /** 可选：搜索半径（米），默认 10000 */
  radiusMeters?: number;
  /** 可选：当前坐标（用于按距离排序） */
  center?: { lng: number; lat: number };
  /** 可选：预算范围（元） */
  budget?: { min: number; max: number };
  /** 可选：最低评分 */
  minRating?: number;
  /** 可选：最大返回数 */
  limit?: number;
  /** 可选：饮食限制（仅餐厅） */
  dietary?: Array<"vegetarian" | "halal" | "low-carb" | "gluten-free" | "spicy">;
  /** 可选：菜系（仅餐厅） */
  cuisine?: Cuisine;
}

export interface ScoredPOI<T extends POI = POI> {
  poi: T;
  distanceMeters: number;
  /** 综合评分 0-1 */
  score: number;
  /** 评分明细 */
  breakdown: {
    ratingScore: number;
    distanceScore: number;
    priceScore: number;
    dietaryScore: number;
  };
}

// ─── 内置数据 ──────────────────────────────────────────────────────

const ACTIVITY_DATA: ActivityPOI[] = [
  // 北京
  { id: "bj-001", name: "颐和园", city: "北京", district: "海淀", lng: 116.275, lat: 39.999, category: "cultural", rating: 4.7, pricePerPerson: 30, avgDuration: 3, tags: ["历史", "园林", "UNESCO"], description: "清代皇家园林，世界文化遗产", openingHours: "06:30-18:00" },
  { id: "bj-002", name: "798 艺术区", city: "北京", district: "朝阳", lng: 116.497, lat: 39.984, category: "cultural", rating: 4.5, pricePerPerson: 0, avgDuration: 2.5, tags: ["艺术", "拍照", "文艺"], description: "现代艺术展览与创意市集", openingHours: "10:00-18:00" },
  { id: "bj-003", name: "三里屯太古里", city: "北京", district: "朝阳", lng: 116.453, lat: 39.937, category: "shopping", rating: 4.6, pricePerPerson: 0, avgDuration: 2, tags: ["购物", "潮流", "餐饮"], description: "时尚购物与娱乐综合体", openingHours: "10:00-22:00" },
  { id: "bj-004", name: "朝阳公园", city: "北京", district: "朝阳", lng: 116.479, lat: 39.939, category: "outdoor", rating: 4.4, pricePerPerson: 5, avgDuration: 2, tags: ["公园", "跑步", "亲子"], description: "市中心大型综合公园", openingHours: "06:00-22:00" },
  { id: "bj-005", name: "故宫博物院", city: "北京", district: "东城", lng: 116.397, lat: 39.916, category: "cultural", rating: 4.8, pricePerPerson: 60, avgDuration: 4, tags: ["历史", "UNESCO", "必游"], description: "明清两代皇家宫殿", openingHours: "-,08:30-17:00,08:30-17:00,08:30-17:00,08:30-17:00,08:30-17:00,08:30-17:00" },
  { id: "bj-006", name: "南锣鼓巷", city: "北京", district: "东城", lng: 116.403, lat: 39.937, category: "cultural", rating: 4.3, pricePerPerson: 50, avgDuration: 1.5, tags: ["胡同", "小吃", "文艺"], description: "北京最古老街区之一", openingHours: "09:00-22:00" },
  { id: "bj-007", name: "环球影城", city: "北京", district: "通州", lng: 116.685, lat: 39.781, category: "entertainment", rating: 4.7, pricePerPerson: 528, avgDuration: 8, tags: ["主题乐园", "亲子", "刺激"], description: "Universal Studios 北京", openingHours: "09:00-21:00" },
  { id: "bj-008", name: "什刹海", city: "北京", district: "西城", lng: 116.386, lat: 39.943, category: "outdoor", rating: 4.5, pricePerPerson: 0, avgDuration: 2, tags: ["夜景", "酒吧", "划船"], description: "老北京水系与胡同", openingHours: "00:00-23:59" },

  // 上海
  { id: "sh-001", name: "外滩", city: "上海", district: "黄浦", lng: 121.490, lat: 31.236, category: "cultural", rating: 4.8, pricePerPerson: 0, avgDuration: 2, tags: ["夜景", "必游", "拍照"], description: "万国建筑群与黄浦江", openingHours: "00:00-23:59" },
  { id: "sh-002", name: "迪士尼乐园", city: "上海", district: "浦东", lng: 121.667, lat: 31.143, category: "entertainment", rating: 4.7, pricePerPerson: 475, avgDuration: 8, tags: ["主题乐园", "亲子"], description: "Shanghai Disney Resort", openingHours: "08:30-20:30" },
  { id: "sh-003", name: "豫园", city: "上海", district: "黄浦", lng: 121.492, lat: 31.227, category: "cultural", rating: 4.5, pricePerPerson: 40, avgDuration: 2, tags: ["古典园林", "小吃"], description: "明代私人花园", openingHours: "09:00-21:00" },
  { id: "sh-004", name: "田子坊", city: "上海", district: "卢湾", lng: 121.466, lat: 31.211, category: "cultural", rating: 4.4, pricePerPerson: 0, avgDuration: 1.5, tags: ["文艺", "石库门"], description: "创意工作室聚集地", openingHours: "10:00-22:00" },
  { id: "sh-005", name: "南京路步行街", city: "上海", district: "黄浦", lng: 121.479, lat: 31.236, category: "shopping", rating: 4.4, pricePerPerson: 0, avgDuration: 1.5, tags: ["购物", "步行街"], description: "中华商业第一街", openingHours: "09:00-22:00" },
  { id: "sh-006", name: "世纪公园", city: "上海", district: "浦东", lng: 121.551, lat: 31.219, category: "outdoor", rating: 4.5, pricePerPerson: 10, avgDuration: 2, tags: ["公园", "跑步"], description: "浦东最大城市公园", openingHours: "06:00-21:00" },
  { id: "sh-007", name: "武康路", city: "上海", district: "徐汇", lng: 121.421, lat: 31.211, category: "cultural", rating: 4.6, pricePerPerson: 0, avgDuration: 1.5, tags: ["梧桐", "咖啡", "文艺"], description: "梧桐树下的老洋房", openingHours: "00:00-23:59" },
  { id: "sh-008", name: "上海博物馆", city: "上海", district: "黄浦", lng: 121.476, lat: 31.230, category: "cultural", rating: 4.7, pricePerPerson: 0, avgDuration: 3, tags: ["文物", "免费"], description: "中国古代艺术博物馆", openingHours: "-,09:00-17:00,09:00-17:00,09:00-17:00,09:00-17:00,09:00-17:00,09:00-17:00" },

  // 深圳
  { id: "sz-001", name: "华侨城欢乐谷", city: "深圳", district: "南山", lng: 113.989, lat: 22.544, category: "entertainment", rating: 4.5, pricePerPerson: 230, avgDuration: 6, tags: ["主题乐园", "过山车"], description: "大型现代主题乐园", openingHours: "10:00-18:00" },
  { id: "sz-002", name: "深圳湾公园", city: "深圳", district: "福田", lng: 113.943, lat: 22.519, category: "outdoor", rating: 4.7, pricePerPerson: 0, avgDuration: 2, tags: ["海景", "跑步", "日落"], description: "深圳湾畔城市绿道", openingHours: "00:00-23:59" },
  { id: "sz-003", name: "华强北商业街", city: "深圳", district: "福田", lng: 114.089, lat: 22.547, category: "shopping", rating: 4.2, pricePerPerson: 0, avgDuration: 1.5, tags: ["电子", "购物"], description: "中国电子第一街", openingHours: "10:00-20:00" },
  { id: "sz-004", name: "世界之窗", city: "深圳", district: "南山", lng: 113.972, lat: 22.537, category: "entertainment", rating: 4.4, pricePerPerson: 220, avgDuration: 6, tags: ["主题乐园", "世界文化"], description: "世界著名景观微缩景区", openingHours: "09:00-18:00" },
  { id: "sz-005", name: "莲花山公园", city: "深圳", district: "福田", lng: 114.064, lat: 22.554, category: "outdoor", rating: 4.6, pricePerPerson: 0, avgDuration: 1.5, tags: ["公园", "城市中心"], description: "深圳市中心标志性公园", openingHours: "06:00-22:00" },
  { id: "sz-006", name: "大梅沙海滨公园", city: "深圳", district: "盐田", lng: 114.310, lat: 22.595, category: "outdoor", rating: 4.4, pricePerPerson: 0, avgDuration: 4, tags: ["海滩", "免费"], description: "深圳最大的免费海滨公园", openingHours: "08:00-22:00" },
];

const RESTAURANT_DATA: RestaurantPOI[] = [
  // 北京
  { id: "bj-r-001", name: "全聚德（王府井店）", city: "北京", district: "东城", lng: 116.411, lat: 39.913, category: "dining", cuisine: "chinese", rating: 4.5, pricePerPerson: 180, avgDuration: 1.5, tags: ["烤鸭", "老字号"], description: "百年烤鸭老字号", signature: ["北京烤鸭", "芥末鸭掌"], dietaryOptions: [], openingHours: "11:00-21:30" },
  { id: "bj-r-002", name: "海底捞（朝阳大悦城店）", city: "北京", district: "朝阳", lng: 116.490, lat: 39.911, category: "dining", cuisine: "hotpot", rating: 4.6, pricePerPerson: 130, avgDuration: 1.5, tags: ["火锅", "服务好"], description: "川式火锅连锁", signature: ["麻辣锅底", "捞派捞面"], dietaryOptions: ["spicy"], openingHours: "10:00-07:00" },
  { id: "bj-r-003", name: "鼎泰丰（侨福芳草地店）", city: "北京", district: "朝阳", lng: 116.450, lat: 39.913, category: "dining", cuisine: "chinese", rating: 4.7, pricePerPerson: 150, avgDuration: 1, tags: ["小笼包", "精致"], description: "米其林推荐小笼包", signature: ["蟹粉小笼包", "虾仁烧麦"], dietaryOptions: [], openingHours: "11:00-21:30" },
  { id: "bj-r-004", name: "鼎泰丰素菜馆", city: "北京", district: "朝阳", lng: 116.451, lat: 39.914, category: "dining", cuisine: "vegetarian", rating: 4.4, pricePerPerson: 120, avgDuration: 1, tags: ["素食", "精致"], description: "素食版鼎泰丰", signature: ["素菜小笼包"], dietaryOptions: ["vegetarian"], openingHours: "11:00-21:30" },

  // 上海
  { id: "sh-r-001", name: "南翔馒头店（豫园）", city: "上海", district: "黄浦", lng: 121.492, lat: 31.227, category: "dining", cuisine: "chinese", rating: 4.5, pricePerPerson: 80, avgDuration: 1, tags: ["小笼包", "老字号"], description: "百年南翔小笼", signature: ["鲜肉小笼", "蟹粉小笼"], dietaryOptions: [], openingHours: "08:30-20:30" },
  { id: "sh-r-002", name: "外婆家（徐汇店）", city: "上海", district: "徐汇", lng: 121.435, lat: 31.199, category: "dining", cuisine: "chinese", rating: 4.4, pricePerPerson: 70, avgDuration: 1, tags: ["杭帮菜", "实惠"], description: "杭帮菜连锁", signature: ["茶香鸡", "麻婆豆腐"], dietaryOptions: ["spicy"], openingHours: "10:30-21:00" },
  { id: "sh-r-003", name: "小杨生煎（南京路店）", city: "上海", district: "黄浦", lng: 121.479, lat: 31.236, category: "dining", cuisine: "chinese", rating: 4.3, pricePerPerson: 25, avgDuration: 0.5, tags: ["生煎", "小吃"], description: "上海街头生煎包", signature: ["鲜肉生煎"], dietaryOptions: [], openingHours: "08:00-20:00" },
  { id: "sh-r-004", name: "Manner Coffee（武康路店）", city: "上海", district: "徐汇", lng: 121.421, lat: 31.211, category: "dining", cuisine: "cafe", rating: 4.5, pricePerPerson: 35, avgDuration: 1, tags: ["咖啡", "网红"], description: "上海本土精品咖啡", signature: ["拿铁", "dirty"], dietaryOptions: ["low-carb"], openingHours: "08:00-20:00" },

  // 深圳
  { id: "sz-r-001", name: "润园四季（华侨城店）", city: "深圳", district: "南山", lng: 113.989, lat: 22.544, category: "dining", cuisine: "cantonese", rating: 4.6, pricePerPerson: 200, avgDuration: 1.5, tags: ["椰子鸡", "粤菜"], description: "深圳特色椰子鸡", signature: ["原味椰子鸡"], dietaryOptions: [], openingHours: "11:00-22:00" },
  { id: "sz-r-002", name: "潮汕牛肉火锅（福田店）", city: "深圳", district: "福田", lng: 114.057, lat: 22.541, category: "dining", cuisine: "chinese", rating: 4.7, pricePerPerson: 110, avgDuration: 1.5, tags: ["牛肉", "鲜切"], description: "现切潮汕牛肉", signature: ["吊龙", "嫩肉"], dietaryOptions: [], openingHours: "11:00-23:00" },
  { id: "sz-r-003", name: "陈鹏鹏卤鹅（南山店）", city: "深圳", district: "南山", lng: 113.923, lat: 22.530, category: "dining", cuisine: "cantonese", rating: 4.5, pricePerPerson: 150, avgDuration: 1, tags: ["卤鹅", "潮汕"], description: "潮汕卤味专门店", signature: ["卤鹅拼盘"], dietaryOptions: [], openingHours: "10:00-21:00" },
  { id: "sz-r-004", name: "喜茶（万象城店）", city: "深圳", district: "罗湖", lng: 114.118, lat: 22.547, category: "dining", cuisine: "cafe", rating: 4.4, pricePerPerson: 30, avgDuration: 0.5, tags: ["奶茶", "新茶饮"], description: "深圳本土新茶饮", signature: ["多肉葡萄", "芝士莓莓"], dietaryOptions: [], openingHours: "10:00-22:00" },
];

// ─── 数据索引 ──────────────────────────────────────────────────────

const ALL_POIS: POI[] = [...ACTIVITY_DATA, ...RESTAURANT_DATA];

/** 城市坐标（用于无 center 时的默认中心） */
const CITY_CENTERS: Record<string, { lng: number; lat: number }> = {
  北京: { lng: 116.407, lat: 39.904 },
  上海: { lng: 121.473, lat: 31.230 },
  深圳: { lng: 114.057, lat: 22.543 },
};

// ─── 距离计算（Haversine 公式） ──────────────────────────────────────

const EARTH_RADIUS_M = 6_371_000;

function haversineDistance(a: { lng: number; lat: number }, b: { lng: number; lat: number }): number {
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

// ─── 评分函数 ──────────────────────────────────────────────────────

function ratingScore(rating: number): number {
  // 4.0 → 0.5, 4.5 → 0.75, 5.0 → 1.0
  return Math.max(0, Math.min(1, (rating - 3.0) / 2));
}

function distanceScore(distanceM: number, radiusM: number): number {
  if (distanceM <= 0) return 1;
  // 距离 0 → 1.0, 距离 = radius → 0
  return Math.max(0, 1 - distanceM / radiusM);
}

function priceScore(price: number, budget?: { min: number; max: number }): number {
  if (!budget) return 0.5;  // 无预算约束时中性
  if (price < budget.min) return 0.3;  // 太便宜也未必好
  if (price > budget.max) return 0;  // 超预算 = 0
  // 落在 [min, mid=(min+max)/2, max] 三个区间：mid 最优
  const mid = (budget.min + budget.max) / 2;
  if (price <= mid) {
    return 0.5 + 0.5 * (price - budget.min) / (mid - budget.min);
  }
  return 1 - 0.5 * (price - mid) / (budget.max - mid);
}

function dietaryScore(poi: POI, required?: string[]): number {
  if (!required || required.length === 0) return 1;
  if (poi.category !== "dining") return 0.5;
  const avail = new Set(poi.dietaryOptions);
  const matches = required.filter((d) => avail.has(d as never)).length;
  return matches / required.length;
}

// ─── 公开 API ──────────────────────────────────────────────────────

export function searchPOIs<T extends POI = POI>(query: POIQuery): ScoredPOI<T>[] {
  const radius = query.radiusMeters ?? 10_000;
  const center = query.center ?? CITY_CENTERS[query.city];
  const limit = query.limit ?? 5;

  if (!center) {
    // 未知城市 → 退化为按 rating 排序的前 N 个
    return ALL_POIS
      .filter((p) => p.city === query.city)
      .filter((p) => !query.category || p.category === query.category)
      .filter((p) => !query.district || p.district === query.district)
      .filter((p) => !query.minRating || p.rating >= query.minRating)
      .filter((p) => {
        if (!query.budget) return true;
        return p.pricePerPerson >= query.budget.min && p.pricePerPerson <= query.budget.max;
      })
      .slice(0, limit)
      .map((poi) => ({
        poi: poi as T,
        distanceMeters: 0,
        score: ratingScore(poi.rating),
        breakdown: { ratingScore: ratingScore(poi.rating), distanceScore: 0, priceScore: 0.5, dietaryScore: 1 },
      }));
  }

  const candidates: ScoredPOI<T>[] = [];

  for (const poi of ALL_POIS) {
    // 城市必须匹配
    if (poi.city !== query.city) continue;
    // 行政区可选
    if (query.district && poi.district !== query.district) continue;
    // 类别过滤
    if (query.category && poi.category !== query.category) continue;
    // 菜系过滤（仅餐厅）
    if (query.cuisine && poi.category === "dining" && poi.cuisine !== query.cuisine) continue;

    const distance = haversineDistance(center, poi);
    if (distance > radius) continue;

    // 评分
    if (query.minRating && poi.rating < query.minRating) continue;
    if (query.budget && (poi.pricePerPerson < query.budget.min || poi.pricePerPerson > query.budget.max)) continue;

    const r = ratingScore(poi.rating);
    const d = distanceScore(distance, radius);
    const p = priceScore(poi.pricePerPerson, query.budget);
    const diet = dietaryScore(poi, query.dietary);

    // 综合得分（距离 40% + 评分 35% + 价格 15% + 饮食 10%）
    const composite = 0.4 * d + 0.35 * r + 0.15 * p + 0.1 * diet;

    candidates.push({
      poi: poi as T,
      distanceMeters: Math.round(distance),
      score: Number(composite.toFixed(3)),
      breakdown: {
        ratingScore: Number(r.toFixed(2)),
        distanceScore: Number(d.toFixed(2)),
        priceScore: Number(p.toFixed(2)),
        dietaryScore: Number(diet.toFixed(2)),
      },
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, limit);
}

export function getPOIById(id: string): POI | undefined {
  return ALL_POIS.find((p) => p.id === id);
}

export function getSupportedCities(): string[] {
  return Object.keys(CITY_CENTERS);
}

export function getCityCenter(city: string): { lng: number; lat: number } | undefined {
  return CITY_CENTERS[city];
}

export function getDatabaseStats() {
  const byCity: Record<string, { activities: number; restaurants: number }> = {};
  for (const poi of ALL_POIS) {
    if (!byCity[poi.city]) byCity[poi.city] = { activities: 0, restaurants: 0 };
    if (poi.category === "dining") byCity[poi.city].restaurants++;
    else byCity[poi.city].activities++;
  }
  return {
    total: ALL_POIS.length,
    cities: Object.keys(byCity),
    byCity,
  };
}
