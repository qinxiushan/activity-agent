/**
 * Activity Planner Tools - 23 个活动规划工具（SOP v2）
 *
 * 真实 SOP 工具集（用户新设计）：
 * - 阶段 1（意图）：
 *   - intent_parse：记录结构化意图
 *   - ask_clarification：1 次追问（受 plan-state 硬限）
 * - 阶段 2（自动规划，无需用户）：
 *   - get_weather：天气预报
 *   - search_activities：活动 POI 查询
 *   - search_restaurants：餐厅 POI 查询
 *   - check_opening_hours：营业时间校验
 *   - compute_route：通勤时间计算
 * - 阶段 3-4（行程落地）：
 *   - commit_itinerary：冻结方案并生成可下载 ICS 日历与交接链接
 * - 持久化：
 *   - plan_save：保存最终方案
 *   - plan_load：加载历史方案
 *
 * 全部工具通过 planState.guardToolCall() 校验 phase，
 * 并通过 tool-wrapper 提供 retry + fallback。
 */

import { createHash } from "node:crypto";
import { Type, type Static } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  getDatabaseStats,
} from "../../lib/poi-database";
import {
  wrapToolWithResilience,
  dataQueryWrapOpts,
  writeOpWrapOpts,
  persistWrapOpts,
  recordToolMetric,
} from "../../lib/tool-wrapper";
import {
  MAX_CLARIFICATIONS,
  getActivePlanState,
  getMissingCriticalFields,
  type PlanStateManager,
} from "../../lib/plan-state";
import { hashOf } from "../../lib/plan-reducer";
import { getDataProvider, getDataProviderStatus } from "../../lib/data-provider-factory";
import { assessDataQuality } from "../../lib/data-quality";
import { getItineraryService } from "../../lib/itinerary-service";
import { getUserPreferencesStore } from "../../lib/user-preferences";
import { getCurrentUserId } from "../../lib/user-context";
import { buildPlaceLinks } from "../../lib/place-links";
import type { ProviderPoi } from "../../lib/data-provider";
import { CandidateDiscoveryService } from "../../lib/candidate-discovery";
import { RoutePlanningService } from "../../lib/route-planning-service";
import { ItineraryValidator } from "../../lib/itinerary-validator";
import type { RoutePoint } from "../../lib/data-provider";
import { BudgetService, type BudgetBreakdown } from "../../lib/budget-service";
import { normalizeClarification } from "../../lib/clarification";

// ─── Schema 定义 ──────────────────────────────────────────────────

const intentRecordSchema = Type.Object({
  date: Type.Optional(Type.String({ description: "日期 YYYY-MM-DD" })),
  startTime: Type.Optional(Type.String({ description: "开始时间 HH:MM" })),
  endTime: Type.Optional(Type.String({ description: "结束时间 HH:MM（默认 +6h）" })),
  departurePoint: Type.Optional(Type.Object({
    name: Type.String({ description: "出发地名称" }),
    city: Type.String({ description: "城市名称；高德数据源支持全国" }),
    lng: Type.Optional(Type.Number({ description: "经度；规划阶段由 geocode 补全" })),
    lat: Type.Optional(Type.Number({ description: "纬度；规划阶段由 geocode 补全" })),
  }, { description: "出发地点；初始意图只需名称和城市" })),
  partySize: Type.Optional(Type.Number({ description: "人数" })),
  groupType: Type.Optional(Type.String({ description: "人群类型: single/couple/friends/family" })),
  budgetPerPerson: Type.Optional(Type.Number({ description: "人均预算（元）" })),
  preferredCategories: Type.Optional(Type.Array(Type.String(), { description: "活动类型偏好: outdoor/cultural/shopping/entertainment" })),
  dietaryRestrictions: Type.Optional(Type.Array(Type.String(), { description: "饮食限制: vegetarian/halal/low-carb" })),
  mood: Type.Optional(Type.String({ description: "氛围: relaxed/active/cultural/foodie/romantic" })),
  specialRequests: Type.Optional(Type.Array(Type.String(), { description: "特殊需求" })),
  endPolicy: Type.Optional(Type.Union([
    Type.Literal("last_poi"),
    Type.Literal("return_to_start"),
    Type.Literal("specified"),
  ], { description: "终点策略；用户未说明时默认 last_poi" })),
  endPoint: Type.Optional(Type.Object({
    name: Type.String(),
    city: Type.Optional(Type.String()),
    lng: Type.Optional(Type.Number()),
    lat: Type.Optional(Type.Number()),
  }, { description: "endPolicy=specified 时的指定终点" })),
  transportPreferences: Type.Optional(Type.Array(Type.Union([
    Type.Literal("walking"),
    Type.Literal("transit"),
    Type.Literal("driving"),
    Type.Literal("bicycling"),
  ]), { description: "可接受的交通方式；默认四种均可" })),
  submitPlan: Type.Optional(Type.Boolean({ description: "旧版兼容字段；新流程禁止使用，请调用 submit_plan" })),
  plan: Type.Optional(Type.Object({
    summary: Type.String({ description: "方案摘要" }),
    idempotencyKey: Type.Optional(Type.String({ description: "旧版兼容提交的幂等键" })),
    validationToken: Type.Optional(Type.String({ description: "validate_itinerary 返回的 validationToken；V3 提交必填" })),
    budgetToken: Type.Optional(Type.String({ description: "calculate_budget 返回的 budgetToken；V4 提交必填" })),
    timeline: Type.Array(Type.Object({
      startTime: Type.String({ description: "HH:MM" }),
      endTime: Type.String({ description: "HH:MM" }),
      type: Type.Union([
        Type.Literal("departure"),
        Type.Literal("transit"),
        Type.Literal("activity"),
        Type.Literal("meal"),
        Type.Literal("rest"),
      ], { description: "条目类型" }),
      poiId: Type.Optional(Type.String()),
      poiName: Type.Optional(Type.String()),
      notes: Type.Optional(Type.String()),
    })),
    totalCost: Type.Optional(Type.Number({ description: "全体预计总花费；V4 必须等于 budgetBreakdown.projectedTotal" })),
    budgetBreakdown: Type.Optional(Type.Object({
      currency: Type.Literal("CNY"),
      partySize: Type.Number(),
      budgetPerPerson: Type.Number(),
      budgetLimit: Type.Number(),
      knownTotal: Type.Number(),
      estimatedTotal: Type.Number(),
      reserveTotal: Type.Number(),
      minimumTotal: Type.Number(),
      likelyTotal: Type.Number(),
      maximumTotal: Type.Number(),
      projectedTotal: Type.Number(),
      projectedPerPerson: Type.Number(),
      remaining: Type.Number(),
      status: Type.Union([Type.Literal("within"), Type.Literal("near_limit"), Type.Literal("exceeded")]),
      completeness: Type.Number(),
      unknownPriceCount: Type.Number(),
      reserveStrategy: Type.Union([
        Type.Literal("minimal"), Type.Literal("balanced"), Type.Literal("conservative"),
      ]),
      assumptions: Type.Array(Type.String()),
      items: Type.Array(Type.Object({
        id: Type.String(),
        category: Type.Union([
          Type.Literal("activity"), Type.Literal("dining"), Type.Literal("transport"), Type.Literal("reserve"),
        ]),
        label: Type.String(),
        amount: Type.Number(),
        perPersonAmount: Type.Number(),
        quantity: Type.Number(),
        confidence: Type.Union([Type.Literal("exact"), Type.Literal("estimate"), Type.Literal("unknown")]),
        source: Type.Union([
          Type.Literal("mock"), Type.Literal("amap"),
          Type.Literal("route_estimate"), Type.Literal("comparable_pois"),
          Type.Literal("category_prior"), Type.Literal("generic_fallback"),
        ]),
        originalPriceKnown: Type.Boolean(),
        priceRange: Type.Object({
          status: Type.Union([Type.Literal("exact"), Type.Literal("estimated"), Type.Literal("unresolved")]),
          low: Type.Number(),
          likely: Type.Number(),
          high: Type.Number(),
          planningReserve: Type.Number(),
          source: Type.Union([
            Type.Literal("mock"), Type.Literal("amap"), Type.Literal("comparable_pois"),
            Type.Literal("category_prior"), Type.Literal("generic_fallback"),
          ]),
          confidence: Type.Union([
            Type.Literal("high"), Type.Literal("medium"), Type.Literal("low"), Type.Literal("unknown"),
          ]),
          basis: Type.String(),
          sampleSize: Type.Optional(Type.Number()),
        }),
        minimumAmount: Type.Number(),
        likelyAmount: Type.Number(),
        maximumAmount: Type.Number(),
        poiId: Type.Optional(Type.String()),
        route: Type.Optional(Type.Object({
          fromId: Type.String(),
          toId: Type.String(),
          mode: Type.Union([
            Type.Literal("walking"), Type.Literal("transit"), Type.Literal("driving"), Type.Literal("bicycling"),
          ]),
        })),
        note: Type.String(),
      })),
    }, { description: "旧版兼容字段；服务端按 budgetToken 使用规范化账本并忽略此副本" })),
    totalDurationMinutes: Type.Optional(Type.Number({ description: "总时长分钟；遗漏时服务端按时间轴补算" })),
    weather: Type.Optional(Type.Object({
      city: Type.String(),
      date: Type.String(),
      condition: Type.String(),
      tempMax: Type.Number(),
      tempMin: Type.Number(),
      advice: Type.String(),
    }, { description: "天气；遗漏时服务端查询真实天气补全" })),
  }, { description: "旧版提交兼容对象；新流程只调用 submit_plan 并传两个 token" })),
});

const submitPlanSchema = Type.Object({
  summary: Type.String({
    minLength: 1,
    maxLength: 500,
    description: "面向用户的简短方案摘要；不得在这里复制 timeline 或 budgetBreakdown",
  }),
  validationToken: Type.String({
    minLength: 1,
    description: "validate_itinerary 返回的 validationToken",
  }),
  budgetToken: Type.String({
    minLength: 1,
    description: "calculate_budget 返回的 budgetToken",
  }),
  idempotencyKey: Type.Optional(Type.String({
    minLength: 8,
    maxLength: 128,
    description: "逻辑提交的稳定幂等键；同一方案重试必须复用。省略时服务端根据摘要和两个 token 确定性生成",
  })),
});

const askClarificationSchema = Type.Object({
  missingFields: Type.Optional(Type.Array(Type.String(), {
    maxItems: 5,
    description: "兼容字段，可省略；服务端会以当前 intent 实际缺失的关键字段为准",
  })),
  title: Type.Optional(Type.String({ description: "追问卡片标题" })),
  description: Type.Optional(Type.String({ description: "卡片辅助说明" })),
  question: Type.Optional(Type.String({ description: "兼容旧流程的合并问题；未传 questions 时服务端自动生成结构化问题" })),
  questions: Type.Optional(Type.Array(Type.Object({
    id: Type.String({ description: "稳定问题 ID，例如 party_size" }),
    field: Type.Union([
      Type.Literal("date"), Type.Literal("startTime"), Type.Literal("endTime"),
      Type.Literal("departurePoint"), Type.Literal("partySize"), Type.Literal("budgetPerPerson"),
      Type.Literal("groupType"), Type.Literal("preferredCategories"),
      Type.Literal("dietaryRestrictions"), Type.Literal("mood"), Type.Literal("specialRequests"),
    ]),
    type: Type.Union([
      Type.Literal("single_select"), Type.Literal("multi_select"), Type.Literal("text"),
      Type.Literal("number"), Type.Literal("date"), Type.Literal("time"), Type.Literal("location"),
    ]),
    title: Type.String(),
    description: Type.Optional(Type.String()),
    required: Type.Boolean(),
    options: Type.Optional(Type.Array(Type.Object({
      value: Type.Union([Type.String(), Type.Number()]),
      label: Type.String(),
      description: Type.Optional(Type.String()),
    }), { maxItems: 12 })),
    allowCustomInput: Type.Optional(Type.Boolean()),
    placeholder: Type.Optional(Type.String()),
    fallbackValue: Type.Optional(Type.Unknown()),
    min: Type.Optional(Type.Number()),
    max: Type.Optional(Type.Number()),
  }), { minItems: 1, maxItems: 8, description: "模型可提交至多 8 个候选问题；服务端只保留当前实际缺失的最多 5 个关键字段" })),
  fallbackDefaults: Type.Optional(Type.Object({}, { additionalProperties: true, description: "若用户不回答时的默认值" })),
});

const getWeatherSchema = Type.Object({
  city: Type.String({ description: "城市名称；高德数据源支持全国" }),
  date: Type.String({ description: "日期 YYYY-MM-DD" }),
});

const geocodeSchema = Type.Object({
  address: Type.String({ description: "出发地名称，如国贸/上海虹桥站" }),
  city: Type.Optional(Type.String({ description: "城市；省略时由高德识别" })),
});

const detectUserRegionSchema = Type.Object({});

const reverseGeocodeSchema = Type.Object({
  lng: Type.Number({ description: "高德 GCJ-02 经度" }),
  lat: Type.Number({ description: "高德 GCJ-02 纬度" }),
});

const searchPlacesTextSchema = Type.Object({
  keywords: Type.Array(Type.String(), { minItems: 1, maxItems: 5, description: "1-5 个关键词；可用于城市级或指定名称搜索" }),
  city: Type.Optional(Type.String({ description: "限制城市；指定后只返回该城市结果" })),
  types: Type.Optional(Type.Array(Type.String(), { maxItems: 10, description: "高德 POI typecode 或类别编码" })),
  page: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 25 })),
  excludePoiIds: Type.Optional(Type.Array(Type.String(), { maxItems: 100, description: "排除上一方案或已推荐的 POI" })),
});

const searchPlacesNearbySchema = Type.Object({
  location: Type.Object({ lng: Type.Number(), lat: Type.Number() }, { description: "搜索中心，必须是 GCJ-02 坐标" }),
  keywords: Type.Optional(Type.Array(Type.String(), { maxItems: 5 })),
  types: Type.Optional(Type.Array(Type.String(), { maxItems: 10, description: "高德 POI typecode 或类别编码" })),
  radiusMeters: Type.Optional(Type.Integer({ minimum: 100, maximum: 50_000 })),
  page: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  pageSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 25 })),
  excludePoiIds: Type.Optional(Type.Array(Type.String(), { maxItems: 100, description: "排除上一方案或已推荐的 POI" })),
});

const getPlaceDetailsSchema = Type.Object({
  poiIds: Type.Array(Type.String(), { minItems: 1, maxItems: 10, description: "由搜索工具返回的 POI ID；一次最多 10 个" }),
});

const discoverPlaceCandidatesSchema = Type.Object({
  city: Type.String({ description: "规划城市" }),
  center: Type.Object({ lng: Type.Number(), lat: Type.Number() }, { description: "出发地或当前行程锚点的 GCJ-02 坐标" }),
  keywords: Type.Array(Type.String(), { minItems: 1, maxItems: 4, description: "1-4 个互补关键词，例如 展览/美术馆/摄影展；不要传同义重复词" }),
  types: Type.Optional(Type.Array(Type.String(), { maxItems: 10, description: "高德 POI typecode 或类别编码" })),
  category: Type.Optional(Type.Union([
    Type.Literal("activity"),
    Type.Literal("dining"),
    Type.Literal("mixed"),
  ], { description: "候选用途；activity 排除餐饮，dining 只保留餐饮，mixed 不限制" })),
  radiusMeters: Type.Optional(Type.Integer({ minimum: 500, maximum: 50_000 })),
  candidateCount: Type.Optional(Type.Integer({ minimum: 3, maximum: 20 })),
  diversityWeight: Type.Optional(Type.Number({ minimum: 0, maximum: 1, description: "多样性权重，默认 0.7；越高越惩罚同类型/同区域候选" })),
  excludePoiIds: Type.Optional(Type.Array(Type.String(), { maxItems: 100, description: "额外排除项；服务端还会自动合并本会话已提交方案 POI" })),
  modes: Type.Optional(Type.Array(Type.Union([
    Type.Literal("text"),
    Type.Literal("nearby"),
  ]), { minItems: 1, maxItems: 2, description: "默认同时执行关键词和周边搜索" })),
});

const searchActivitiesSchema = Type.Object({
  city: Type.String(),
  district: Type.Optional(Type.String()),
  category: Type.Optional(Type.String({ description: "outdoor/cultural/shopping/entertainment" })),
  budgetMin: Type.Optional(Type.Number()),
  budgetMax: Type.Optional(Type.Number()),
  minRating: Type.Optional(Type.Number()),
  radiusMeters: Type.Optional(Type.Number()),
  limit: Type.Optional(Type.Number()),
  center: Type.Optional(Type.Object({ lng: Type.Number(), lat: Type.Number() }, { description: "搜索中心点（默认出发地）" })),
  preferIndoor: Type.Optional(Type.Boolean({ description: "是否优先推荐室内" })),
});

const searchRestaurantsSchema = Type.Object({
  city: Type.String(),
  district: Type.Optional(Type.String()),
  cuisine: Type.Optional(Type.String()),
  budgetMin: Type.Optional(Type.Number()),
  budgetMax: Type.Optional(Type.Number()),
  dietary: Type.Optional(Type.Array(Type.String())),
  minRating: Type.Optional(Type.Number()),
  radiusMeters: Type.Optional(Type.Number()),
  limit: Type.Optional(Type.Number()),
  center: Type.Optional(Type.Object({ lng: Type.Number(), lat: Type.Number() })),
});

const checkOpeningHoursSchema = Type.Object({
  poiId: Type.String({ description: "POI ID" }),
  datetime: Type.String({ description: "目标时间 ISO 格式 YYYY-MM-DDTHH:MM:SS" }),
});

const computeRouteSchema = Type.Object({
  fromPoiId: Type.Optional(Type.String({ description: "起点 POI ID" })),
  toPoiId: Type.String({ description: "终点 POI ID" }),
  fromCoord: Type.Optional(Type.Object({ name: Type.String(), lng: Type.Number(), lat: Type.Number() }, { description: "起点坐标（用于出发地）" })),
  mode: Type.Optional(Type.String({ description: "walking/transit/driving/bicycling" })),
});

const routeEndpointSchema = Type.Object({
  id: Type.String({ description: "本次规划内稳定 ID，例如 start/end 或 POI ID" }),
  poiId: Type.Optional(Type.String({ description: "已有 POI 时优先传 POI ID" })),
  name: Type.Optional(Type.String()),
  city: Type.Optional(Type.String()),
  lng: Type.Optional(Type.Number()),
  lat: Type.Optional(Type.Number()),
});

const compareRouteOptionsSchema = Type.Object({
  from: routeEndpointSchema,
  to: routeEndpointSchema,
  modes: Type.Optional(Type.Array(Type.Union([
    Type.Literal("walking"), Type.Literal("transit"), Type.Literal("driving"), Type.Literal("bicycling"),
  ]), { minItems: 1, maxItems: 4, description: "默认同时比较四种方式" })),
  priority: Type.Optional(Type.Union([
    Type.Literal("balanced"), Type.Literal("fastest"), Type.Literal("cheapest"), Type.Literal("low_walking"),
  ])),
  weatherCondition: Type.Optional(Type.String()),
  maxWalkingMinutes: Type.Optional(Type.Integer({ minimum: 0, maximum: 180 })),
});

const distanceMatrixSchema = Type.Object({
  points: Type.Array(routeEndpointSchema, { minItems: 2, maxItems: 8 }),
  mode: Type.Optional(Type.Union([
    Type.Literal("straight"), Type.Literal("walking"), Type.Literal("driving"),
  ], { description: "用于排序的矩阵方式；默认 driving" })),
  startId: Type.String({ description: "固定起点 ID" }),
  fixedEndId: Type.Optional(Type.String({ description: "指定终点或返程终点 ID；last_poi 时不传" })),
});

const validateItinerarySchema = Type.Object({
  date: Type.String({ description: "YYYY-MM-DD" }),
  startTime: Type.String({ description: "HH:MM" }),
  endTime: Type.String({ description: "HH:MM" }),
  start: routeEndpointSchema,
  endPolicy: Type.Optional(Type.Union([
    Type.Literal("last_poi"), Type.Literal("return_to_start"), Type.Literal("specified"),
  ])),
  end: Type.Optional(routeEndpointSchema),
  stops: Type.Array(Type.Object({
    poiId: Type.String(),
    type: Type.Union([Type.Literal("activity"), Type.Literal("meal"), Type.Literal("rest")]),
    durationMinutes: Type.Integer({ minimum: 1, maximum: 480 }),
    notes: Type.Optional(Type.String()),
  }), { minItems: 1, maxItems: 8 }),
  legs: Type.Array(Type.Object({
    fromId: Type.String(),
    toId: Type.String(),
    mode: Type.Union([
      Type.Literal("walking"), Type.Literal("transit"), Type.Literal("driving"), Type.Literal("bicycling"),
    ]),
    distanceMeters: Type.Number({ minimum: 0 }),
    durationMinutes: Type.Integer({ minimum: 1 }),
    estimatedCost: Type.Number({ minimum: 0 }),
  }), { maxItems: 9 }),
  bufferMinutes: Type.Optional(Type.Integer({ minimum: 0, maximum: 30 })),
});

const calculateBudgetSchema = Type.Object({
  partySize: Type.Integer({ minimum: 1, maximum: 100 }),
  budgetPerPerson: Type.Number({ minimum: 0 }),
  stops: Type.Array(Type.Object({
    poiId: Type.String(),
    type: Type.Union([Type.Literal("activity"), Type.Literal("meal")]),
  }), { minItems: 1, maxItems: 8 }),
  legs: Type.Array(Type.Object({
    fromId: Type.String(),
    toId: Type.String(),
    mode: Type.Union([
      Type.Literal("walking"), Type.Literal("transit"), Type.Literal("driving"), Type.Literal("bicycling"),
    ]),
    estimatedCost: Type.Number({ minimum: 0 }),
    costConfidence: Type.Optional(Type.Union([
      Type.Literal("exact"), Type.Literal("estimate"), Type.Literal("unknown"),
    ])),
  }), { maxItems: 9 }),
  reserveStrategy: Type.Optional(Type.Union([
    Type.Literal("minimal"), Type.Literal("balanced"), Type.Literal("conservative"),
  ], { description: "未知价格规划策略；默认 balanced。预算严格时用 conservative，不得为了迎合预算故意选 minimal" })),
});

const commitItinerarySchema = Type.Object({
  planHash: Type.String({ description: "当前确认方案的指纹；必须与服务端版本一致" }),
});

const planSaveSchema = Type.Object({
  planId: Type.Optional(Type.String()),
  intent: Type.Optional(Type.Object({}, { additionalProperties: true })),
  plan: Type.Optional(Type.Object({}, { additionalProperties: true })),
});

const planLoadSchema = Type.Object({
  planId: Type.Optional(Type.String()),
});

const orderIdSchema = Type.Object({
  orderId: Type.String({ description: "订单 ID" }),
});

// route-B 改动 3：LLM 结构化意图分类（取代 advancePlanPhase 的正则）
const classifyTurnSchema = Type.Object({
  intent: Type.Union([
    Type.Literal("new_request"),
    Type.Literal("smalltalk"),
    Type.Literal("answer"),
    Type.Literal("confirm"),
    Type.Literal("modify"),
    Type.Literal("reject"),
    Type.Literal("question"),
    Type.Literal("cancel"),
  ], { description: "用户这一轮消息的意图分类。new_request 仅表示明确要求本地活动/行程规划；单纯问候、寒暄、能力询问或无关请求必须用 smalltalk" }),
  confidence: Type.Number({ description: "分类置信度 0.0-1.0" }),
  reason: Type.Optional(Type.String({ description: "简短分类理由" })),
});

function serializePlace(poi: ProviderPoi) {
  return {
    id: poi.id,
    name: poi.name,
    city: poi.city,
    district: poi.district,
    address: poi.address ?? poi.description,
    location: { lng: poi.lng, lat: poi.lat, coordinateSystem: "GCJ-02" as const },
    category: poi.category,
    typecode: poi.typecode ?? poi.tags[0],
    rating: poi.rating,
    averageCostPerPerson: poi.pricePerPerson,
    openingHours: poi.openingHours,
    telephone: poi.telephone,
    businessArea: poi.businessArea,
    photos: poi.photos ?? [],
    source: poi.source,
    dataCompleteness: {
      rating: poi.rating !== null,
      cost: poi.pricePerPerson !== null,
      openingHours: poi.openingHours !== null,
    },
    links: buildPlaceLinks(poi),
  };
}

function toolError(code: string, message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({
      error: true,
      code,
      message,
      retryable: code === "ITINERARY_TOKEN_INVALID" || code === "BUDGET_TOKEN_INVALID",
    }, null, 2) }],
    details: { error: true, code, message },
  };
}

function withDataQuality<T extends object>(
  operation: string,
  value: T,
  requestedSource: "mock" | "amap",
): T & { dataQuality: ReturnType<typeof assessDataQuality> } {
  return {
    ...value,
    dataQuality: assessDataQuality(operation, value, requestedSource),
  };
}

// ─── 工具注册表 ──────────────────────────────────────────────────

export function getActivityPlannerTools(): ToolDefinition[] {
  const candidateDiscovery = new CandidateDiscoveryService();
  const resolveRoutePoint = async (input: Static<typeof routeEndpointSchema>): Promise<RoutePoint> => {
    if (input.poiId) {
      const poi = await getDataProvider().getPoiById(input.poiId);
      if (!poi) throw new Error(`POI ${input.poiId} not found`);
      return { id: input.id, name: poi.name, city: poi.city, lng: poi.lng, lat: poi.lat };
    }
    if (!input.name || input.lng === undefined || input.lat === undefined) {
      throw new Error(`Route endpoint ${input.id} requires poiId or name+lng+lat`);
    }
    return { id: input.id, name: input.name, city: input.city, lng: input.lng, lat: input.lat };
  };
  const submitCanonicalPlan = async (
    params: {
      summary: string;
      idempotencyKey?: string;
      validationToken?: string;
      budgetToken?: string;
      weather?: {
        city: string;
        date: string;
        condition: string;
        tempMax: number;
        tempMin: number;
        advice: string;
      };
    },
    mgr: PlanStateManager | null | undefined,
  ) => {
    if (!mgr) {
      return toolError("NO_ACTIVE_PLAN_STATE", "plan state not initialized");
    }
    const requestFingerprint = createHash("sha256").update(JSON.stringify({
      summary: params.summary,
      validationToken: params.validationToken ?? "",
      budgetToken: params.budgetToken ?? "",
    })).digest("hex").slice(0, 24);
    const idempotencyKey = params.idempotencyKey?.trim() ||
      `plan_${requestFingerprint}`;
    return mgr.withPlanSubmissionLock(idempotencyKey, async () => {
      const previous = mgr.resolvePlanSubmission(idempotencyKey, requestFingerprint);
      if (previous.status === "conflict") {
        return toolError(
          "IDEMPOTENCY_KEY_CONFLICT",
          `幂等键 ${idempotencyKey} 已用于另一份方案，请为不同方案使用新的幂等键。`,
        );
      }
      if (previous.status === "replay") {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            planSubmitted: true,
            plan: previous.plan,
            planHash: previous.planHash,
            idempotencyKey,
            idempotentReplay: true,
            nextPhase: "plan_confirm",
            canonicalArtifactsUsed: true,
            messageToUser: "该方案已提交；本次返回的是同一幂等请求的既有结果。",
          }, null, 2) }],
          details: {
            planSubmitted: true,
            plan: previous.plan,
            planHash: previous.planHash,
            idempotencyKey,
            idempotentReplay: true,
            canonicalArtifactsUsed: true,
          },
        };
      }
      if (mgr.currentPhase !== "planning") {
        return toolError(
          "SUBMIT_PLAN_OUT_OF_PHASE",
          `submit_plan 仅在 planning 阶段合法（当前阶段: ${mgr.currentPhase}）。`,
        );
      }
      const artifacts = mgr.resolvePlanningArtifacts(
        params.validationToken ?? "",
        params.budgetToken ?? "",
      );
      if (!artifacts.ok) return toolError(artifacts.code, artifacts.message);

      const submittedPlan = await completeSubmittedPlan({
        summary: params.summary,
        validationToken: params.validationToken,
        budgetToken: params.budgetToken,
        timeline: artifacts.timeline,
        budgetBreakdown: artifacts.budgetBreakdown,
        warnings: artifacts.warnings,
        totalCost: artifacts.budgetBreakdown.projectedTotal,
        weather: params.weather,
      }, mgr.intent);
      const planHash = hashOf(submittedPlan);
      const out = await mgr.dispatchPlanSubmission(submittedPlan, {
        idempotencyKey,
        requestFingerprint,
        planHash,
      });
      if (out.phase !== "plan_confirm") {
        return toolError(
          "PHASE_TRANSITION_FAILED",
          `plan 提交后未进入 plan_confirm（当前 ${out.phase}；effects: ${out.effects.join(",")}）`,
        );
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify({
          planSubmitted: true,
          plan: submittedPlan,
          planHash,
          idempotencyKey,
          idempotentReplay: false,
          nextPhase: "plan_confirm",
          canonicalArtifactsUsed: true,
          messageToUser: "方案已生成，请用户确认（确认/修改/重新生成）",
        }, null, 2) }],
        details: {
          planSubmitted: true,
          plan: submittedPlan,
          planHash,
          idempotencyKey,
          idempotentReplay: false,
          canonicalArtifactsUsed: true,
        },
      };
    });
  };
  const baseTools: ToolDefinition[] = [

    // ── 结构化意图分类（route-B 改动 3，每轮先调） ─────────

    {
      name: "classify_turn",
      label: "classify_turn",
      description: "活动工作流入口与阶段意图分类。idle/completed/cancelled 阶段中，只有用户明确要求本地活动或行程规划时才传 new_request；单纯问候、寒暄、能力询问、无关请求或尚未表达规划意愿时传 smalltalk，phase 保持不变。clarifying/plan_confirm 阶段再使用 answer/confirm/modify/reject/question/cancel。confirm 置信度<0.8 时不会转移。",
      promptSnippet: "意图分类",
      parameters: classifyTurnSchema,
      execute: async (_id, params: Static<typeof classifyTurnSchema>) => {
        const mgr = getActivePlanState();
        if (!mgr) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({
              error: true, code: "NO_ACTIVE_PLAN_STATE", message: "plan state not initialized",
            }, null, 2) }],
            details: { error: true },
          };
        }
        const { intent, confidence } = params;

        // 低置信度 + 不可逆确认 → 不猜、不转移（fail-closed），引导二次确认 / 点按钮
        if (intent === "confirm" && confidence < 0.8) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({
              classified: intent, confidence, transitioned: false, phase: mgr.currentPhase,
              note: "确认意图置信度不足，未提交行程。请向用户明确二次确认，或提示其点击「确认并生成行程」按钮。",
            }, null, 2) }],
            details: { classified: intent, confidence, transitioned: false },
          };
        }

        // 文本确认走当前方案指纹（结构化按钮才是防注入主路径，此为文本兜底）
        const planHash = intent === "confirm" ? hashOf(mgr.plan) : undefined;
        const out = await mgr.dispatch({ type: "USER_TURN_CLASSIFIED", intent, planHash });

        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            classified: intent, confidence, phase: out.phase, effects: out.effects,
            note: nextStepHint(out.phase),
          }, null, 2) }],
          details: { classified: intent, phase: out.phase, effects: out.effects },
        };
      },
    },

    // ── 阶段 1：意图捕获 ───────────────────────────────────

    {
      name: "intent_parse",
      label: "intent_parse",
      description: "记录用户意图（结构化）。模型分析用户输入后，调用此工具保存 date/startTime/departurePoint/partySize/budgetPerPerson/preferences。旧版 submitPlan 参数仅为兼容；新规划必须使用 submit_plan。",
      promptSnippet: "记录意图",
      parameters: intentRecordSchema,
      execute: async (_id, params: Static<typeof intentRecordSchema>) => {
        const mgr = getActivePlanState();

        if (params.submitPlan && params.plan) {
          return submitCanonicalPlan({
            summary: params.plan.summary,
            idempotencyKey: params.plan.idempotencyKey,
            validationToken: params.plan.validationToken,
            budgetToken: params.plan.budgetToken,
            weather: params.plan.weather,
          }, mgr);
        }

        if (mgr) {
          mgr.recordIntent({
            date: params.date,
            startTime: params.startTime,
            endTime: params.endTime,
            departurePoint: params.departurePoint,
            partySize: params.partySize,
            groupType: params.groupType as never,
            budgetPerPerson: params.budgetPerPerson,
            preferredCategories: params.preferredCategories,
            dietaryRestrictions: params.dietaryRestrictions,
            mood: params.mood,
            specialRequests: params.specialRequests,
            endPolicy: params.endPolicy ?? mgr.intent.endPolicy ?? "last_poi",
            ...(params.endPoint ? { endPoint: params.endPoint } : {}),
            ...(params.transportPreferences
              ? { transportPreferences: params.transportPreferences }
              : {}),
          });

          let autoFilledFields: string[] = [];
          if (mgr.currentPhase === "intent_capture") {
            const { filled, autoFilledFields: af } = await getUserPreferencesStore().autoFillIntent(mgr.intent);
            if (af.length > 0) {
              mgr.recordIntent(filled);
              autoFilledFields = af;
            }
            const missing = getMissingCriticalFields(mgr.intent);
            await mgr.dispatch({ type: "INTENT_FIELDS_UPDATED", missingCount: missing.length });
          }

          const providerStatus = getDataProviderStatus();
          return {
            content: [{ type: "text" as const, text: JSON.stringify({
              saved: true,
              intent: mgr.intent,
              autoFilledFields,
              supportedCities: providerStatus.activeSource === "amap" ? "全国（高德）" : "北京、上海、深圳（mock）",
              dataProvider: providerStatus,
              currentPhase: mgr.currentPhase,
              note: autoFilledFields.length > 0
                ? `已用用户偏好自动填充 ${autoFilledFields.length} 个字段：${autoFilledFields.join("、")}。请在回复中告知用户，并允许覆盖。`
                : "若关键字段缺失，调用 ask_clarification 一次性追问（最多 1 次）",
            }, null, 2) }],
            details: { ...params, _autoFilled: autoFilledFields },
          };
        }

        const providerStatus = getDataProviderStatus();
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            saved: true,
            intent: params,
            supportedCities: providerStatus.activeSource === "amap" ? "全国（高德）" : "北京、上海、深圳（mock）",
            dataProvider: providerStatus,
            currentPhase: "unknown",
            note: "若关键字段缺失，调用 ask_clarification 一次性追问（最多 1 次）",
          }, null, 2) }],
          details: params,
        };
      },
    },

    {
      name: "submit_plan",
      label: "submit_plan",
      description: "提交最终方案的唯一首选入口。只传摘要、validationToken 和 budgetToken；服务端按 token 取回规范化 timeline、budgetBreakdown、totalCost 并组装方案。禁止复制或改写工具返回的大对象。仅 planning 阶段可调用。",
      promptSnippet: "用两个 token 提交规范方案",
      parameters: submitPlanSchema,
      execute: async (_id, params: Static<typeof submitPlanSchema>) =>
        submitCanonicalPlan(params, getActivePlanState()),
    },

    {
      name: "ask_clarification",
      label: "ask_clarification",
      description: `仅在用户已经明确要求规划、phase=intent_capture 且关键字段缺失时生成一次结构化追问卡片。missingFields 可省略，服务端按已记录 intent 自动推导；可选偏好不是追问理由，服务端会过滤非缺失字段。问候/寒暄不得调用。受 phase 守卫 + MAX_CLARIFICATIONS(${MAX_CLARIFICATIONS}) 硬限。`,
      promptSnippet: "1 次追问（硬限）",
      parameters: askClarificationSchema,
      execute: async (_id, params: Static<typeof askClarificationSchema>) => {
        const mgr = getActivePlanState();
        if (!mgr) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({
              error: true, code: "NO_ACTIVE_PLAN_STATE", message: "plan state not initialized",
            }, null, 2) }],
            details: { error: true },
          };
        }

        const canonicalMissing = getMissingCriticalFields(mgr.intent);
        if (canonicalMissing.length === 0) {
          return toolError(
            "NO_MISSING_CRITICAL_FIELDS",
            "当前没有缺失的关键字段，请直接进入自动规划，不要追问可选偏好。",
          );
        }
        const canonicalSet = new Set<string>(canonicalMissing);
        const clarification = normalizeClarification({
          title: params.title,
          description: params.description,
          missingFields: canonicalMissing,
          question: params.question,
          questions: params.questions?.filter((item) => canonicalSet.has(item.field)),
          fallbackDefaults: params.fallbackDefaults as Record<string, unknown> | undefined,
        });
        const incremented = mgr.incrementClarification();
        if (!incremented) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({
              error: true,
              code: "MAX_CLARIFICATIONS_EXCEEDED",
              message: `追问次数已用完（${MAX_CLARIFICATIONS} 次硬限）。请用 fallbackDefaults 自动推进。`,
              forcedAction: "transition_to_planning_with_defaults",
            }, null, 2) }],
            details: { error: true, code: "MAX_CLARIFICATIONS_EXCEEDED" },
          };
        }

        mgr.recordPendingClarification(clarification);
        const clarifyOut = await mgr.dispatch({ type: "CLARIFICATION_ASKED" });
        if (clarifyOut.phase !== "clarifying") {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({
              error: true, code: "PHASE_TRANSITION_FAILED",
              message: `进入 clarifying 失败（当前 ${clarifyOut.phase}；effects: ${clarifyOut.effects.join(",")}）`,
            }, null, 2) }],
            details: { error: true, code: "PHASE_TRANSITION_FAILED" },
          };
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            clarificationAsked: true,
            clarification,
            hardLimit: MAX_CLARIFICATIONS,
            clarificationsUsed: mgr.clarificationCount,
            instructionToUser: "结构化卡片已显示在前端，请等待用户通过卡片一次性提交；不要再用自然语言重复追问。",
          }, null, 2) }],
          details: { asked: true, clarification },
        };
      },
    },

    // ── 阶段 2：自动规划（无用户交互） ────────────────────

    {
      name: "detect_user_region",
      label: "detect_user_region",
      description: "根据服务端可信代理提供的当前用户公网 IP 推断城市。仅提供城市级弱提示，不能作为精确出发地；本地开发、私网、未配置信任代理时会明确返回不可用。不得要求或回显用户原始 IP。",
      promptSnippet: "IP 城市提示",
      parameters: detectUserRegionSchema,
      execute: async () => {
        const clientIp = getActivePlanState()?.clientIp;
        const provider = clientIp ? getDataProvider() : null;
        const result = clientIp && provider
          ? await provider.locateIp(clientIp)
          : {
              available: false,
              accuracy: "unknown" as const,
              canUseAsExactDeparture: false as const,
              source: "unavailable" as const,
              reason: "没有可信公网 IP；本地开发或 TRUST_PROXY_HEADERS 未启用",
            };
        const details = withDataQuality(
          "ip_location",
          result,
          provider?.kind ?? getDataProviderStatus().requestedSource,
        );
        return {
          content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
          details,
        };
      },
    },

    {
      name: "geocode",
      label: "geocode",
      description: "将出发地名称转换为高德 GCJ-02 坐标。全国城市可用；后续所有路径规划都使用此坐标系。",
      promptSnippet: "地理编码出发地",
      parameters: geocodeSchema,
      execute: async (_id, params: Static<typeof geocodeSchema>) => {
        const provider = getDataProvider();
        const result = await provider.geocode(params.address, params.city);
        const details = withDataQuality("geocode", result, provider.kind);
        return { content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }], details };
      },
    },

    {
      name: "reverse_geocode",
      label: "reverse_geocode",
      description: "把用户授权提供的高德 GCJ-02 坐标转换为地址和城市。适用于浏览器定位坐标；不能把 IP 定位结果当作精确坐标。",
      promptSnippet: "逆地理编码",
      parameters: reverseGeocodeSchema,
      execute: async (_id, params: Static<typeof reverseGeocodeSchema>) => {
        const provider = getDataProvider();
        const result = await provider.reverseGeocode({ lng: params.lng, lat: params.lat });
        const details = withDataQuality("reverse_geocode", result, provider.kind);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
          details,
        };
      },
    },

    {
      name: "get_weather",
      label: "get_weather",
      description: "查询指定城市和日期的天气。根据天气给出活动推荐倾向（雨天推室内，晴天推户外）。",
      promptSnippet: "查天气",
      parameters: getWeatherSchema,
      execute: async (_id, params: Static<typeof getWeatherSchema>) => {
        const provider = getDataProvider();
        const w = await provider.getWeather(params.city, params.date);
        const details = withDataQuality("weather", w, provider.kind);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
          details,
        };
      },
    },

    {
      name: "discover_place_candidates",
      label: "discover_place_candidates",
      description: "V2 多样性候选发现：对最多 4 个互补关键词并行执行 text/nearby 搜索，跨查询按 POI ID 和同名近距离去重，再以相关性和 MMR 风格多样性重排。自动排除本会话已提交方案中的 POI，适合首次规划和重新生成。",
      promptSnippet: "构建多样化 POI 候选池",
      parameters: discoverPlaceCandidatesSchema,
      execute: async (_id, params: Static<typeof discoverPlaceCandidatesSchema>) => {
        const mgr = getActivePlanState();
        const provider = getDataProvider();
        const appliedExclusions = mgr?.candidateExclusions(params.excludePoiIds ?? []) ??
          [...new Set(params.excludePoiIds ?? [])];
        const result = await candidateDiscovery.discover(provider, {
          city: params.city,
          center: params.center,
          keywords: params.keywords,
          types: params.types,
          category: params.category,
          radiusMeters: params.radiusMeters,
          candidateCount: params.candidateCount,
          diversityWeight: params.diversityWeight,
          excludePoiIds: appliedExclusions,
          modes: params.modes,
        });
        const details = withDataQuality("candidate_discovery", {
          ...result,
          sessionRecommendedPoiIds: mgr?.recommendedPoiIds ?? [],
          candidates: result.candidates.map((candidate) => ({
            rank: candidate.rank,
            relevanceScore: candidate.relevanceScore,
            diversityScore: candidate.diversityScore,
            matchedKeywords: candidate.matchedKeywords,
            searchModes: candidate.searchModes,
            ...serializePlace(candidate.poi),
          })),
        }, provider.kind);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
          details,
        };
      },
    },

    {
      name: "search_places_text",
      label: "search_places_text",
      description: "高德关键词搜索。用于搜索指定名称、城市特色地点或补充周边搜索；支持分页、typecode 和 excludePoiIds。重新生成方案时必须排除上一方案 POI。",
      promptSnippet: "关键词搜索 POI",
      parameters: searchPlacesTextSchema,
      execute: async (_id, params: Static<typeof searchPlacesTextSchema>) => {
        const provider = getDataProvider();
        const result = await provider.searchPlacesText({
          keywords: params.keywords,
          city: params.city,
          types: params.types,
          page: params.page,
          pageSize: params.pageSize,
          excludePoiIds: params.excludePoiIds,
        });
        const details = withDataQuality("place_search_text", {
          ...result,
          pois: result.pois.map(serializePlace),
        }, provider.kind);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
          details,
        };
      },
    },

    {
      name: "search_places_nearby",
      label: "search_places_nearby",
      description: "高德周边搜索。围绕出发地或上一活动点查询 POI；支持多个关键词、typecode、分页和排除列表。不要只取第一条结果。",
      promptSnippet: "周边搜索 POI",
      parameters: searchPlacesNearbySchema,
      execute: async (_id, params: Static<typeof searchPlacesNearbySchema>) => {
        const provider = getDataProvider();
        const result = await provider.searchPlacesNearby({
          location: params.location,
          keywords: params.keywords,
          types: params.types,
          radiusMeters: params.radiusMeters,
          page: params.page,
          pageSize: params.pageSize,
          excludePoiIds: params.excludePoiIds,
        });
        const details = withDataQuality("place_search_nearby", {
          ...result,
          pois: result.pois.map(serializePlace),
        }, provider.kind);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
          details,
        };
      },
    },

    {
      name: "get_place_details",
      label: "get_place_details",
      description: "批量补全搜索结果中的 POI 详情，一次最多 10 个。返回评分、人均、营业时间、图片、电话、数据完整度和服务端生成的高德/餐厅链接。优先查询候选中的少量 POI，避免 N+1。",
      promptSnippet: "补全 POI 详情",
      parameters: getPlaceDetailsSchema,
      execute: async (_id, params: Static<typeof getPlaceDetailsSchema>) => {
        const uniqueIds = [...new Set(params.poiIds)].slice(0, 10);
        const provider = getDataProvider();
        const places = await provider.getPlaceDetails(uniqueIds);
        const details = withDataQuality("place_details", {
          requested: uniqueIds.length,
          found: places.length,
          missingPoiIds: uniqueIds.filter((id) => !places.some((poi) => poi.id === id)),
          places: places.map(serializePlace),
        }, provider.kind);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
          details,
        };
      },
    },

    {
      name: "search_activities",
      label: "search_activities",
      description: "查询活动 POI。高德数据源支持全国，mock 仅覆盖北京/上海/深圳。必传 city，可选 district/category/budget/rating/center/preferIndoor 过滤。preferIndoor=true 时倾向返回 cultural/shopping 类别。",
      promptSnippet: "搜索活动 POI",
      parameters: searchActivitiesSchema,
      execute: async (_id, params: Static<typeof searchActivitiesSchema>) => {
        const provider = getDataProvider();
        const results = await provider.searchActivities({
          city: params.city,
          district: params.district,
          category: params.category as "outdoor" | "cultural" | "shopping" | "entertainment" | undefined,
          radiusMeters: params.radiusMeters,
          center: params.center,
          budget: params.budgetMin !== undefined && params.budgetMax !== undefined
            ? { min: params.budgetMin, max: params.budgetMax } : undefined,
          minRating: params.minRating,
          limit: params.limit ?? 5,
          preferIndoor: params.preferIndoor,
        });
        const payload = withDataQuality("activity_search", {
            count: results.length,
            activities: results.map((r) => ({
              id: r.poi.id,
              name: r.poi.name,
              category: r.poi.category,
              district: r.poi.district,
              pricePerPerson: r.poi.pricePerPerson,
              rating: r.poi.rating,
              avgDurationHours: r.poi.avgDurationHours,
              distanceMeters: r.distanceMeters,
              relevanceScore: r.score,
              openingHours: r.poi.openingHours ?? "未知",
              source: r.poi.source,
              tags: r.poi.tags,
              description: r.poi.description,
            })),
        }, provider.kind);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
          details: results,
        };
      },
    },

    {
      name: "search_restaurants",
      label: "search_restaurants",
      description: "查询真实餐厅 POI 数据库。支持 cuisine/dietary/budget/rating/center 过滤。",
      promptSnippet: "搜索餐厅 POI",
      parameters: searchRestaurantsSchema,
      execute: async (_id, params: Static<typeof searchRestaurantsSchema>) => {
        const provider = getDataProvider();
        const results = await provider.searchRestaurants({
          city: params.city,
          district: params.district,
          cuisine: params.cuisine,
          radiusMeters: params.radiusMeters,
          center: params.center,
          budget: params.budgetMin !== undefined && params.budgetMax !== undefined
            ? { min: params.budgetMin, max: params.budgetMax } : undefined,
          dietary: params.dietary,
          minRating: params.minRating,
          limit: params.limit ?? 5,
        });
        const payload = withDataQuality("restaurant_search", {
            count: results.length,
            restaurants: results.map((r) => ({
              id: r.poi.id,
              name: r.poi.name,
              cuisine: r.poi.cuisine,
              district: r.poi.district,
              pricePerPerson: r.poi.pricePerPerson,
              rating: r.poi.rating,
              avgDurationHours: r.poi.avgDurationHours,
              distanceMeters: r.distanceMeters,
              relevanceScore: r.score,
              openingHours: r.poi.openingHours ?? "未知",
              source: r.poi.source,
              signature: r.poi.signature ?? [],
              dietaryOptions: r.poi.dietaryOptions ?? [],
              description: r.poi.description,
            })),
        }, provider.kind);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
          details: results,
        };
      },
    },

    {
      name: "check_opening_hours",
      label: "check_opening_hours",
      description: "校验某 POI 在指定时间是否营业。返回 open/close + 当日营业时间字符串 + 原因。",
      promptSnippet: "营业时间校验",
      parameters: checkOpeningHoursSchema,
      execute: async (_id, params: Static<typeof checkOpeningHoursSchema>) => {
        const provider = getDataProvider();
        const result = await provider.checkOpeningHours(params.poiId, params.datetime);
        const details = withDataQuality("opening_hours", result, provider.kind);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
          details,
        };
      },
    },

    {
      name: "compute_route",
      label: "compute_route",
      description: "计算两点之间的通勤时间。可指定交通方式（walking/transit/driving），自动根据距离推断。返回 distanceMeters/durationMinutes/mode/cost。",
      promptSnippet: "算通勤",
      parameters: computeRouteSchema,
      execute: async (_id, params: Static<typeof computeRouteSchema>) => {
        const provider = getDataProvider();
        const toPoi = await provider.getPoiById(params.toPoiId);
        if (!toPoi) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({
              error: true, code: "POI_NOT_FOUND", message: `toPoi ${params.toPoiId} not found`,
            }, null, 2) }],
            details: { error: true },
          };
        }
        let fromCoord: { id: string; name: string; lng: number; lat: number };
        if (params.fromCoord) {
          fromCoord = { id: "custom", ...params.fromCoord };
        } else if (params.fromPoiId) {
          const fromPoi = await provider.getPoiById(params.fromPoiId);
          if (!fromPoi) {
            return {
              content: [{ type: "text" as const, text: JSON.stringify({
                error: true, code: "POI_NOT_FOUND", message: `fromPoi ${params.fromPoiId} not found`,
              }, null, 2) }],
              details: { error: true },
            };
          }
          fromCoord = { id: fromPoi.id, name: fromPoi.name, lng: fromPoi.lng, lat: fromPoi.lat };
        } else {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({
              error: true, code: "MISSING_ORIGIN", message: "Either fromPoiId or fromCoord is required",
            }, null, 2) }],
            details: { error: true },
          };
        }
        const toCoord = { id: toPoi.id, name: toPoi.name, lng: toPoi.lng, lat: toPoi.lat };
        const mode = params.mode as "walking" | "transit" | "driving" | "bicycling" | undefined;
        const route = await provider.computeRoute(fromCoord, toCoord, mode);
        const details = withDataQuality("route", route, provider.kind);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
          details,
        };
      },
    },

    {
      name: "compare_route_options",
      label: "compare_route_options",
      description: "V3 路线决策：并行比较步行、公交、驾车、骑行，保留不可用方式及原因，并按天气、时长、费用与少步行偏好给出推荐。每个最终行程段都应调用。",
      promptSnippet: "四模式路线比较",
      parameters: compareRouteOptionsSchema,
      execute: async (_id, params: Static<typeof compareRouteOptionsSchema>) => {
        const provider = getDataProvider();
        const [from, to] = await Promise.all([resolveRoutePoint(params.from), resolveRoutePoint(params.to)]);
        const result = await new RoutePlanningService(provider).compare(from, to, {
          modes: params.modes,
          priority: params.priority,
          weatherCondition: params.weatherCondition,
          maxWalkingMinutes: params.maxWalkingMinutes,
        });
        const details = withDataQuality("route_comparison", result, provider.kind);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
          details,
        };
      },
    },

    {
      name: "distance_matrix",
      label: "distance_matrix",
      description: "V3 多点距离矩阵与访问顺序建议。一次传 2-8 个点，固定起点，可选固定终点；last_poi 不传 fixedEndId。矩阵用于决定顺序，最终每段仍需 compare_route_options。",
      promptSnippet: "多点距离矩阵",
      parameters: distanceMatrixSchema,
      execute: async (_id, params: Static<typeof distanceMatrixSchema>) => {
        const provider = getDataProvider();
        const points = await Promise.all(params.points.map(resolveRoutePoint));
        if (!points.some((point) => point.id === params.startId)) throw new Error("startId is not present in points");
        if (params.fixedEndId && !points.some((point) => point.id === params.fixedEndId)) throw new Error("fixedEndId is not present in points");
        const result = await new RoutePlanningService(provider).matrix(
          points,
          params.mode ?? "driving",
          params.startId,
          params.fixedEndId,
        );
        const details = withDataQuality("distance_matrix", result, provider.kind);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(details, null, 2) }],
          details,
        };
      },
    },

    {
      name: "validate_itinerary",
      label: "validate_itinerary",
      description: "V3 确定性行程校验与时间轴生成。根据确认的时间窗口、终点策略、停留时长、已选路线和缓冲时间生成 timeline；检查缺失路线、超时、闭店、未知营业时间和异常用餐时间。valid=false 时必须修复后重调，不得提交方案。",
      promptSnippet: "确定性行程校验",
      parameters: validateItinerarySchema,
      execute: async (_id, params: Static<typeof validateItinerarySchema>) => {
        const start = await resolveRoutePoint(params.start);
        const end = params.end ? await resolveRoutePoint(params.end) : undefined;
        const result = await new ItineraryValidator(getDataProvider()).validate({
          date: params.date,
          startTime: params.startTime,
          endTime: params.endTime,
          start,
          endPolicy: params.endPolicy,
          end,
          stops: params.stops,
          legs: params.legs,
          bufferMinutes: params.bufferMinutes,
        });
        const mgr = getActivePlanState();
        if (mgr) {
          await mgr.recordItineraryValidation(
            result.validationToken,
            result.valid,
            result.timeline,
            result.warnings,
          );
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      },
    },

    {
      name: "calculate_budget",
      label: "calculate_budget",
      description: "V4 自适应预算账本。真实价格优先；未知价格依次使用同区域可比 POI、城市/类别区间、宽区间兜底。输出 low/likely/high、规划使用值、来源、可信度、总价范围、人均和余额。validate_itinerary 通过后必须调用；不得把估算说成真实票价。",
      promptSnippet: "统一预算账本",
      parameters: calculateBudgetSchema,
      execute: async (_id, params: Static<typeof calculateBudgetSchema>) => {
        const result = await new BudgetService(getDataProvider()).calculate({
          partySize: params.partySize,
          budgetPerPerson: params.budgetPerPerson,
          stops: params.stops,
          legs: params.legs,
          reserveStrategy: params.reserveStrategy,
        });
        const mgr = getActivePlanState();
        if (mgr) await mgr.recordBudgetCalculation(result.budgetToken, result.breakdown);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      },
    },

    // ── 阶段 3：行程落地 ──────────────────────────────────

    {
      name: "commit_itinerary",
      label: "commit_itinerary",
      description: "确认后的真实行程交付。仅在 executing 阶段调用：校验方案指纹、冻结行程、生成可下载 .ics 日历文件，并返回高德导航及餐厅平台搜索入口。不会替用户预订餐厅，也不会返回确认码。",
      promptSnippet: "交付行程（仅限确认后）",
      parameters: commitItinerarySchema,
      execute: async (_id, params: Static<typeof commitItinerarySchema>) => {
        const mgr = getActivePlanState();
        if (!mgr?.plan) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: true, code: "NO_PLAN" }) }], details: { error: true } };
        }
        const expectedHash = hashOf(mgr.plan);
        if (params.planHash !== expectedHash) {
          return { content: [{ type: "text" as const, text: JSON.stringify({ error: true, code: "PLAN_CHANGED", message: "方案已变化，请重新确认。" }) }], details: { error: true, code: "PLAN_CHANGED" } };
        }
        const result = await getItineraryService().commit({
          sessionId: mgr.current.sessionId, userId: mgr.userId ?? getCurrentUserId(), planHash: expectedHash,
          plan: mgr.plan, provider: getDataProvider(),
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            ...result,
            message: "行程已生成。请下载 .ics 文件导入日历；餐厅链接仅用于前往平台继续订位，不代表已经订位。",
          }, null, 2) }], details: result,
        };
      },
    },

    // ── 持久化 ───────────────────────────────────────────

    {
      name: "plan_save",
      label: "plan_save",
      description: "保存最终活动方案（含 intent + plan）。",
      promptSnippet: "保存方案",
      parameters: planSaveSchema,
      execute: async (_id, params: Static<typeof planSaveSchema>) => {
        const result = { planId: params.planId ?? `plan-${Date.now().toString(36)}`, saved: true };
        const mgr = getActivePlanState();
        if (mgr && mgr.currentPhase === "executing") {
          const out = await mgr.dispatch({ type: "PLAN_SAVED" });
          if (out.phase === "completed") {
            try {
              await getUserPreferencesStore(getCurrentUserId()).recordCompletedSession(mgr.current);
            } catch (e) {
              console.error("[plan_save] recordCompletedSession failed:", e);
            }
          }
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      },
    },

    {
      name: "plan_load",
      label: "plan_load",
      description: "加载历史方案（当前为空实现，预留接口）。",
      promptSnippet: "加载方案",
      parameters: planLoadSchema,
      execute: async (_id, params: Static<typeof planLoadSchema>) => {
        const result = { plans: [], loadedPlanId: params.planId ?? null };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          details: result,
        };
      },
    },
  ];

  // ─── 应用 P0 包装（retry + fallback + phase guard） ──────────

  const sequentialTools = new Set([
    "classify_turn", "intent_parse", "submit_plan", "ask_clarification",
    "validate_itinerary", "calculate_budget", "commit_itinerary", "plan_save",
  ]);
  const dataFallback = async (toolName: string, _params: unknown, err: Error) => ({
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        count: 0, items: [], error: true, fallback: true,
        originalError: err.message,
        message: `数据源暂时不可用 (${toolName})。不得编造 POI、价格、营业时间或位置；请缩小请求范围或如实告知用户。`,
      }, null, 2),
    }],
    details: { fallback: true, originalError: err.message },
  });

  return baseTools.map((baseTool) => {
    // Make concurrency policy explicit instead of depending on an SDK default:
    // read-only queries can share a batch; state mutations serialize the batch.
    const tool: ToolDefinition = {
      ...baseTool,
      executionMode: sequentialTools.has(baseTool.name) ? "sequential" : "parallel",
    };
    // 写操作（行程交付）：重试 + 结构化错误
    if (tool.name === "commit_itinerary") {
      return wrapToolWithResilience(tool, {
        ...writeOpWrapOpts(async (toolName, _params, err) => ({
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: true,
              code: "ITINERARY_COMMIT_FAILED",
              tool: toolName,
              originalError: err.message,
              message: "行程交付暂时不可用，请稍后重试。",
            }, null, 2),
          }],
          details: { error: true, fallback: true },
        })),

        // Phase guard 已迁移到 Extension lib/extensions/phase-guard.ts (T3)
      });
    }

    // Route comparison/matrix already fan out internally. Retrying the entire
    // fan-out multiplies AMap requests and leaves timed-out promises running.
    if (tool.name === "compare_route_options" || tool.name === "distance_matrix") {
      return wrapToolWithResilience(tool, {
        retry: { maxRetries: 0 },
        timeoutMs: 10_000,
        fallback: dataFallback,
        onMetric: recordToolMetric,
      });
    }

    // 数据查询类（POI / 天气 / 营业时间 / 通勤）：重试 + 降级到 LLM 知识
    if ([
      "detect_user_region", "geocode", "reverse_geocode", "get_weather",
      "discover_place_candidates", "search_places_text", "search_places_nearby", "get_place_details",
      "search_activities", "search_restaurants", "check_opening_hours", "compute_route",
      "compare_route_options", "distance_matrix", "validate_itinerary",
      "calculate_budget",
    ].includes(tool.name)) {
      return wrapToolWithResilience(tool, {
        ...dataQueryWrapOpts(dataFallback),

        // Phase guard 已迁移到 Extension lib/extensions/phase-guard.ts (T3)
      });
    }

    // 持久化类：低重试、无 fallback
    if (["plan_save", "plan_load", "intent_parse", "submit_plan"].includes(tool.name)) {
      return wrapToolWithResilience(tool, {
        ...persistWrapOpts,

        // Phase guard 已迁移到 Extension lib/extensions/phase-guard.ts (T3)
      });
    }

    // ask_clarification 走 phase 守卫（不重试，避免重复追问）
    if (tool.name === "ask_clarification") {
      return wrapToolWithResilience(tool, {
        retry: { maxRetries: 0 },
        timeoutMs: 2_000,

        // Phase guard 已迁移到 Extension lib/extensions/phase-guard.ts (T3)
      });
    }

    return tool;
  });
}

// ─── 辅助 ─────────────────────────────────────────────────────────

async function completeSubmittedPlan(
  plan: {
    summary: string;
    validationToken?: string;
    budgetToken?: string;
    budgetBreakdown?: BudgetBreakdown;
    warnings?: Array<{ code: string; message: string; poiId?: string }>;
    timeline: Array<{ startTime: string; endTime: string; type: "departure" | "transit" | "activity" | "meal" | "rest"; poiId?: string; poiName?: string; notes?: string }>;
    totalCost?: number;
    totalDurationMinutes?: number;
    weather?: { city: string; date: string; condition: string; tempMax: number; tempMin: number; advice: string };
  },
  intent?: { date?: string; departurePoint?: { city: string } },
) {
  const minutes = (value: string): number | undefined => {
    const match = /^(\d{1,2}):(\d{2})$/.exec(value);
    return match ? Number(match[1]) * 60 + Number(match[2]) : undefined;
  };
  const first = plan.timeline[0];
  const last = plan.timeline.at(-1);
  const start = first ? minutes(first.startTime) : undefined;
  const end = last ? minutes(last.endTime) : undefined;
  const totalDurationMinutes = plan.totalDurationMinutes ?? (start !== undefined && end !== undefined && end >= start ? end - start : 0);

  const provider = getDataProvider();
  let totalCost = plan.totalCost;
  if (totalCost === undefined) {
    const poiIds = [...new Set(plan.timeline.flatMap((entry) => entry.poiId ? [entry.poiId] : []))];
    const pois = await Promise.all(poiIds.map((id) => provider.getPoiById(id)));
    totalCost = pois.reduce((sum, poi) => sum + (poi?.pricePerPerson ?? 0), 0);
  }

  let weather = plan.weather;
  if (!weather) {
    const city = intent?.departurePoint?.city ?? "";
    const date = intent?.date ?? "";
    try {
      weather = await provider.getWeather(city, date);
    } catch {
      weather = { city, date, condition: "未知", tempMax: 0, tempMin: 0, advice: "天气数据暂不可用，请以实时天气为准" };
    }
  }
  return {
    summary: plan.summary,
    validationToken: plan.validationToken,
    budgetToken: plan.budgetToken,
    budgetBreakdown: plan.budgetBreakdown,
    warnings: plan.warnings,
    timeline: plan.timeline,
    totalCost,
    totalDurationMinutes,
    weather,
  };
}

/** classify_turn 后按新相位给 LLM 的下一步提示 */
function nextStepHint(phase: string): string {
  switch (phase) {
    case "planning": return "已进入 planning：请重新调用规划工具生成方案，最后用 submit_plan 提交两个 token。";
    case "executing": return "已进入 executing：请立即调用 commit_itinerary 生成并交付行程，成功后调 plan_save 完成。";
    case "intent_capture": return "已回到 intent_capture：请重新提取意图并调 intent_parse。";
    case "plan_confirm": return "仍在 plan_confirm（如用户提问）：请回答用户，方案保持不变，等待确认。";
    case "cancelled": return "会话已取消。";
    default: return "";
  }
}

export const TOOL_METADATA = {
  supportedCities: "mock: 北京/上海/深圳；amap: 全国",
  totalPOIs: getDatabaseStats().total,
  toolCount: 23,
  workflow: [
    "intent_capture",
    "clarifying (max 1)",
    "planning (auto)",
    "plan_confirm (ONLY user confirmation)",
    "executing",
    "completed",
  ] as const,
} as const;
