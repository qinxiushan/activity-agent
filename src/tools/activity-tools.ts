/**
 * Activity Planner Tools - 12 个活动规划工具（SOP v2 重构）
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
 * - 阶段 3-4（预订）：
 *   - reservation_exec：真实预订
 *   - query_booking：订单查询
 *   - retry_booking：订单重试
 * - 持久化：
 *   - plan_save：保存最终方案
 *   - plan_load：加载历史方案
 *
 * 全部工具通过 planState.guardToolCall() 校验 phase，
 * 并通过 tool-wrapper 提供 retry + fallback。
 */

import { Type, type Static } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  searchPOIs,
  getPOIById,
  getDatabaseStats,
  type POIQuery,
  type ActivityPOI,
  type RestaurantPOI,
} from "../../lib/poi-database";
import {
  getBookingService,
  formatBookingForTool,
  BookingError,
  type CreateBookingInput,
} from "../../lib/booking-service";
import {
  wrapToolWithResilience,
  dataQueryWrapOpts,
  writeOpWrapOpts,
  persistWrapOpts,
} from "../../lib/tool-wrapper";
import { guardToolCallWithActive, MAX_CLARIFICATIONS, getActivePlanState, getMissingCriticalFields } from "../../lib/plan-state";
import { getWeather } from "../../lib/weather-service";
import { computeRoute, buildRouteChain } from "../../lib/route-service";
import { isOpenAt, parseHoursString } from "../../lib/opening-hours-service";
import { getUserPreferencesStore } from "../../lib/user-preferences";

// ─── Schema 定义 ──────────────────────────────────────────────────

const intentRecordSchema = Type.Object({
  date: Type.Optional(Type.String({ description: "日期 YYYY-MM-DD" })),
  startTime: Type.Optional(Type.String({ description: "开始时间 HH:MM" })),
  endTime: Type.Optional(Type.String({ description: "结束时间 HH:MM（默认 +6h）" })),
  departurePoint: Type.Optional(Type.Object({
    name: Type.String({ description: "出发地名称" }),
    city: Type.String({ description: "城市（北京/上海/深圳）" }),
    lng: Type.Number({ description: "经度" }),
    lat: Type.Number({ description: "纬度" }),
  }, { description: "出发地点（含坐标）" })),
  partySize: Type.Optional(Type.Number({ description: "人数" })),
  groupType: Type.Optional(Type.String({ description: "人群类型: single/couple/friends/family" })),
  budgetPerPerson: Type.Optional(Type.Number({ description: "人均预算（元）" })),
  preferredCategories: Type.Optional(Type.Array(Type.String(), { description: "活动类型偏好: outdoor/cultural/shopping/entertainment" })),
  dietaryRestrictions: Type.Optional(Type.Array(Type.String(), { description: "饮食限制: vegetarian/halal/low-carb" })),
  mood: Type.Optional(Type.String({ description: "氛围: relaxed/active/cultural/foodie/romantic" })),
  specialRequests: Type.Optional(Type.Array(Type.String(), { description: "特殊需求" })),
  submitPlan: Type.Optional(Type.Boolean({ description: "true 表示提交最终方案，触发 plan_confirm 阶段" })),
  plan: Type.Optional(Type.Object({
    summary: Type.String({ description: "方案摘要" }),
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
    totalCost: Type.Number({ description: "总花费元" }),
    totalDurationMinutes: Type.Number({ description: "总时长分钟" }),
    weather: Type.Object({
      city: Type.String(),
      date: Type.String(),
      condition: Type.String(),
      tempMax: Type.Number(),
      tempMin: Type.Number(),
      advice: Type.String(),
    }),
  }, { description: "完整方案（submitPlan=true 时必填）" })),
});

const askClarificationSchema = Type.Object({
  missingFields: Type.Array(Type.String(), { description: "缺失的关键字段名" }),
  question: Type.String({ description: "合并为一个自然语言问题（一次追问）" }),
  fallbackDefaults: Type.Optional(Type.Object({}, { additionalProperties: true, description: "若用户不回答时的默认值" })),
});

const getWeatherSchema = Type.Object({
  city: Type.String({ description: "城市：北京/上海/深圳" }),
  date: Type.String({ description: "日期 YYYY-MM-DD" }),
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
  mode: Type.Optional(Type.String({ description: "walking/transit/driving" })),
});

const reservationExecSchema = Type.Object({
  restaurantId: Type.String(),
  restaurantName: Type.String(),
  date: Type.String({ description: "YYYY-MM-DD" }),
  time: Type.String({ description: "HH:MM（24h）" }),
  partySize: Type.Number({ description: "1-20" }),
  specialRequests: Type.Optional(Type.String()),
  userId: Type.Optional(Type.String()),
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

// ─── 工具注册表 ──────────────────────────────────────────────────

export function getActivityPlannerTools(): ToolDefinition[] {
  const baseTools: ToolDefinition[] = [

    // ── 阶段 1：意图捕获 ───────────────────────────────────

    {
      name: "intent_parse",
      label: "intent_parse",
      description: "记录用户意图（结构化）。模型分析用户输入后，调用此工具保存关键字段：date/startTime/departurePoint/partySize/budgetPerPerson/preferences。submitPlan=true 时传入完整 plan 用于提交方案（触发 plan_confirm）。",
      promptSnippet: "记录意图/提交方案",
      parameters: intentRecordSchema,
      execute: async (_id, params: Static<typeof intentRecordSchema>) => {
        const mgr = getActivePlanState();

        if (params.submitPlan && params.plan) {
          if (mgr && mgr.currentPhase !== "planning") {
            return {
              content: [{ type: "text" as const, text: JSON.stringify({
                error: true,
                code: "SUBMIT_PLAN_OUT_OF_PHASE",
                message: `submitPlan=true 仅在 planning 阶段合法（当前阶段: ${mgr.currentPhase}）。` +
                         `plan_confirm/executing 阶段再次提交方案会覆盖当前执行状态，已被拒绝。`,
                currentPhase: mgr.currentPhase,
              }, null, 2) }],
              details: { error: true, code: "SUBMIT_PLAN_OUT_OF_PHASE" },
            };
          }
          if (mgr) {
            mgr.recordPlan({
              summary: params.plan.summary,
              timeline: params.plan.timeline,
              totalCost: params.plan.totalCost,
              totalDurationMinutes: params.plan.totalDurationMinutes,
              weather: params.plan.weather,
            });
            const result = await mgr.transition("plan_confirm", "plan submitted by LLM");
            if (!result.ok) {
              return {
                content: [{ type: "text" as const, text: JSON.stringify({
                  error: true, code: "PHASE_TRANSITION_FAILED", message: result.error,
                }, null, 2) }],
                details: { error: true, code: "PHASE_TRANSITION_FAILED" },
              };
            }
          }
          return {
            content: [{ type: "text" as const, text: JSON.stringify({
              planSubmitted: true,
              plan: params.plan,
              nextPhase: "plan_confirm",
              messageToUser: "方案已生成，请用户确认（确认/修改/重新生成）",
            }, null, 2) }],
            details: { planSubmitted: true, plan: params.plan },
          };
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
          });

          let autoFilledFields: string[] = [];
          if (mgr.currentPhase === "intent_capture") {
            const { filled, autoFilledFields: af } = await getUserPreferencesStore().autoFillIntent(mgr.intent);
            if (af.length > 0) {
              mgr.recordIntent(filled);
              autoFilledFields = af;
            }
            const missing = getMissingCriticalFields(mgr.intent);
            if (missing.length === 0) {
              await mgr.transition("planning", autoFilledFields.length > 0
                ? `all critical fields captured (${autoFilledFields.length} from user prefs: ${autoFilledFields.join(", ")})`
                : "all critical fields captured");
            }
          }

          return {
            content: [{ type: "text" as const, text: JSON.stringify({
              saved: true,
              intent: mgr.intent,
              autoFilledFields,
              supportedCities: ["北京", "上海", "深圳"],
              currentPhase: mgr.currentPhase,
              note: autoFilledFields.length > 0
                ? `已用用户偏好自动填充 ${autoFilledFields.length} 个字段：${autoFilledFields.join("、")}。请在回复中告知用户，并允许覆盖。`
                : "若关键字段缺失，调用 ask_clarification 一次性追问（最多 1 次）",
            }, null, 2) }],
            details: { ...params, _autoFilled: autoFilledFields },
          };
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            saved: true,
            intent: params,
            supportedCities: ["北京", "上海", "深圳"],
            currentPhase: "unknown",
            note: "若关键字段缺失，调用 ask_clarification 一次性追问（最多 1 次）",
          }, null, 2) }],
          details: params,
        };
      },
    },

    {
      name: "ask_clarification",
      label: "ask_clarification",
      description: `向用户追问关键字段（仅 1 次！）。受 phase 守卫 + MAX_CLARIFICATIONS(${MAX_CLARIFICATIONS}) 硬限。第 2 次调用将被拒绝。必须将所有缺失字段合并为 1 个问题。`,
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

        const transResult = await mgr.transition("clarifying", "ask_clarification invoked");
        if (!transResult.ok) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({
              error: true, code: "PHASE_TRANSITION_FAILED", message: transResult.error,
            }, null, 2) }],
            details: { error: true, code: "PHASE_TRANSITION_FAILED" },
          };
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            clarificationAsked: true,
            missingFields: params.missingFields,
            question: params.question,
            fallbackDefaults: params.fallbackDefaults ?? null,
            hardLimit: MAX_CLARIFICATIONS,
            clarificationsUsed: mgr.clarificationCount,
            instructionToUser: "请用户在 1 条消息中回答所有缺失字段；如不回答则使用 fallbackDefaults 自动推进。",
          }, null, 2) }],
          details: { asked: true, fields: params.missingFields },
        };
      },
    },

    // ── 阶段 2：自动规划（无用户交互） ────────────────────

    {
      name: "get_weather",
      label: "get_weather",
      description: "查询指定城市和日期的天气。根据天气给出活动推荐倾向（雨天推室内，晴天推户外）。",
      promptSnippet: "查天气",
      parameters: getWeatherSchema,
      execute: async (_id, params: Static<typeof getWeatherSchema>) => {
        const w = getWeather(params.city, params.date);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(w, null, 2) }],
          details: w,
        };
      },
    },

    {
      name: "search_activities",
      label: "search_activities",
      description: "查询真实活动 POI 数据库（北京/上海/深圳）。必传 city，可选 district/category/budget/rating/center/preferIndoor 过滤。preferIndoor=true 时倾向返回 cultural/shopping 类别。",
      promptSnippet: "搜索活动 POI",
      parameters: searchActivitiesSchema,
      execute: async (_id, params: Static<typeof searchActivitiesSchema>) => {
        const query: POIQuery = {
          city: params.city,
          district: params.district,
          category: params.category as POIQuery["category"],
          radiusMeters: params.radiusMeters,
          center: params.center,
          budget: params.budgetMin !== undefined && params.budgetMax !== undefined
            ? { min: params.budgetMin, max: params.budgetMax } : undefined,
          minRating: params.minRating,
          limit: params.limit ?? 5,
        };
        let results = searchPOIs<ActivityPOI>(query);
        if (params.preferIndoor) {
          results = results.filter((r) => r.poi.category === "cultural" || r.poi.category === "shopping");
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            count: results.length,
            activities: results.map((r) => ({
              id: r.poi.id,
              name: r.poi.name,
              category: r.poi.category,
              district: r.poi.district,
              pricePerPerson: r.poi.pricePerPerson,
              rating: r.poi.rating,
              avgDurationHours: r.poi.avgDuration,
              distanceMeters: r.distanceMeters,
              relevanceScore: r.score,
              openingHours: r.poi.openingHours,
              tags: r.poi.tags,
              description: r.poi.description,
            })),
          }, null, 2) }],
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
        const query: POIQuery = {
          city: params.city,
          district: params.district,
          category: "dining",
          cuisine: params.cuisine as POIQuery["cuisine"],
          radiusMeters: params.radiusMeters,
          center: params.center,
          budget: params.budgetMin !== undefined && params.budgetMax !== undefined
            ? { min: params.budgetMin, max: params.budgetMax } : undefined,
          dietary: params.dietary as POIQuery["dietary"],
          minRating: params.minRating,
          limit: params.limit ?? 5,
        };
        const results = searchPOIs<RestaurantPOI>(query);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            count: results.length,
            restaurants: results.map((r) => ({
              id: r.poi.id,
              name: r.poi.name,
              cuisine: r.poi.cuisine,
              district: r.poi.district,
              pricePerPerson: r.poi.pricePerPerson,
              rating: r.poi.rating,
              avgDurationHours: r.poi.avgDuration,
              distanceMeters: r.distanceMeters,
              relevanceScore: r.score,
              openingHours: r.poi.openingHours,
              signature: r.poi.signature,
              dietaryOptions: r.poi.dietaryOptions,
              description: r.poi.description,
            })),
          }, null, 2) }],
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
        const poi = getPOIById(params.poiId);
        if (!poi) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({
              error: true, code: "POI_NOT_FOUND", message: `POI ${params.poiId} not found`,
            }, null, 2) }],
            details: { error: true },
          };
        }
        const when = new Date(params.datetime);
        const hours = parseHoursString(poi.openingHours);
        const result = isOpenAt(hours, when);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            poiId: poi.id, poiName: poi.name, datetime: params.datetime, ...result,
          }, null, 2) }],
          details: { ...result, hoursSummary: hours.summary },
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
        const toPoi = getPOIById(params.toPoiId);
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
          const fromPoi = getPOIById(params.fromPoiId);
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
        const mode = params.mode as "walking" | "transit" | "driving" | undefined;
        const route = computeRoute(fromCoord, toCoord, mode);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(route, null, 2) }],
          details: route,
        };
      },
    },

    // ── 阶段 3：执行预订 ──────────────────────────────────

    {
      name: "reservation_exec",
      label: "reservation_exec",
      description: "执行餐厅预订。⚠️ 仅在用户对最终方案说\"确认\"之后才能调用（phase=executing）。在 plan_confirm 阶段调用会被 phase 守卫拒绝。返回 orderId，订单进入 pending → processing → confirmed/failed 异步流程。失败时可用 retry_booking 重试。",
      promptSnippet: "执行预订（仅限确认后）",
      parameters: reservationExecSchema,
      execute: async (_id, params: Static<typeof reservationExecSchema>) => {
        const input: CreateBookingInput = {
          restaurantId: params.restaurantId,
          restaurantName: params.restaurantName,
          date: params.date,
          time: params.time,
          partySize: params.partySize,
          specialRequests: params.specialRequests,
          userId: params.userId ?? "default",
        };
        try {
          const order = await getBookingService().createBooking(input);
          const formatted = formatBookingForTool(order);
          return {
            content: [{ type: "text" as const, text: JSON.stringify({
              ...formatted,
              message: "订单已创建，可用 query_booking 工具查询状态。",
            }, null, 2) }],
            details: formatted,
          };
        } catch (e) {
          if (e instanceof BookingError) {
            return {
              content: [{ type: "text" as const, text: JSON.stringify({
                error: true, code: e.code, message: e.message, suggestion: suggestFix(e.code),
              }, null, 2) }],
              details: { error: true, code: e.code, message: e.message },
            };
          }
          throw e;
        }
      },
    },

    {
      name: "query_booking",
      label: "query_booking",
      description: "查询订单状态，确认时返回确认码。",
      promptSnippet: "查询订单",
      parameters: orderIdSchema,
      execute: async (_id, params: Static<typeof orderIdSchema>) => {
        const order = await getBookingService().getOrder(params.orderId);
        if (!order) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ error: true, code: "ORDER_NOT_FOUND" }, null, 2) }],
            details: { error: true },
          };
        }
        const formatted = formatBookingForTool(order);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(formatted, null, 2) }],
          details: formatted,
        };
      },
    },

    {
      name: "retry_booking",
      label: "retry_booking",
      description: "重试失败的预订订单。订单状态必须为 failed。",
      promptSnippet: "重试订单",
      parameters: orderIdSchema,
      execute: async (_id, params: Static<typeof orderIdSchema>) => {
        try {
          const order = await getBookingService().retryOrder(params.orderId);
          const formatted = formatBookingForTool(order);
          return {
            content: [{ type: "text" as const, text: JSON.stringify({ retried: true, ...formatted }, null, 2) }],
            details: formatted,
          };
        } catch (e) {
          if (e instanceof BookingError) {
            return {
              content: [{ type: "text" as const, text: JSON.stringify({ error: true, code: e.code, message: e.message }, null, 2) }],
              details: { error: true, code: e.code },
            };
          }
          throw e;
        }
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
          const trans = await mgr.transition("completed", "plan saved");
          if (trans.ok) {
            try {
              await getUserPreferencesStore().recordCompletedSession(mgr.current);
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

  return baseTools.map((tool) => {
    // 写操作（预订）：重试 + 降级
    if (tool.name === "reservation_exec" || tool.name === "retry_booking") {
      return wrapToolWithResilience(tool, {
        ...writeOpWrapOpts(async (toolName, _params, err) => ({
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              error: true,
              code: "BOOKING_FALLBACK",
              tool: toolName,
              originalError: err.message,
              message: "预订服务暂时不可用，请稍后用 retry_booking 重试",
            }, null, 2),
          }],
          details: { error: true, fallback: true },
        })),
        beforeExecute: guardToolCallWithActive,
      });
    }

    // 数据查询类（POI / 天气 / 营业时间 / 通勤）：重试 + 降级到 LLM 知识
    if (["search_activities", "search_restaurants", "get_weather", "check_opening_hours", "compute_route"].includes(tool.name)) {
      return wrapToolWithResilience(tool, {
        ...dataQueryWrapOpts(async (toolName, _params, err) => ({
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              count: 0, items: [], error: true, fallback: true,
              originalError: err.message,
              message: `数据源暂时不可用 (${toolName})，请基于 LLM 训练知识继续`,
            }, null, 2),
          }],
          details: { fallback: true, originalError: err.message },
        })),
        beforeExecute: guardToolCallWithActive,
      });
    }

    // 持久化类：低重试、无 fallback
    if (["plan_save", "plan_load", "query_booking", "intent_parse"].includes(tool.name)) {
      return wrapToolWithResilience(tool, {
        ...persistWrapOpts,
        beforeExecute: guardToolCallWithActive,
      });
    }

    // ask_clarification 走 phase 守卫（不重试，避免重复追问）
    if (tool.name === "ask_clarification") {
      return wrapToolWithResilience(tool, {
        retry: { maxRetries: 0 },
        timeoutMs: 2_000,
        beforeExecute: guardToolCallWithActive,
      });
    }

    return tool;
  });
}

// ─── 辅助 ─────────────────────────────────────────────────────────

function suggestFix(code: string): string {
  const suggestions: Record<string, string> = {
    RESTAURANT_NOT_FOUND: "请先用 search_restaurants 工具查询有效餐厅 ID",
    INVALID_RESTAURANT: "传入的 ID 不是餐厅，请用活动 POI 重新调用 search_activities",
    INVALID_DATE: "日期格式必须为 YYYY-MM-DD",
    INVALID_TIME: "时间格式必须为 HH:MM（24 小时制）",
    PAST_DATE: "不能预订过去日期",
    INVALID_PARTY_SIZE: "人数必须在 1-20 之间",
  };
  return suggestions[code] ?? "请检查输入参数";
}

export const TOOL_METADATA = {
  supportedCities: ["北京", "上海", "深圳"],
  totalPOIs: getDatabaseStats().total,
  toolCount: 12,
  workflow: [
    "intent_capture",
    "clarifying (max 1)",
    "planning (auto)",
    "plan_confirm (ONLY user confirmation)",
    "executing",
    "completed",
  ] as const,
} as const;
