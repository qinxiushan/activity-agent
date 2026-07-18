// lib/storage/index.ts — repo 工厂（阶段 2 T1）
//
// 按 STORAGE_BACKEND 环境变量返回 repo 实例：
//   file     → file-repos（阶段 1 行为，默认）
//   postgres → pg-repos
//
// 缓存机制：首次调用创建并缓存（惰性单例），避免每次调用重走工厂。
// 注意：dev server 热重载时模块级变量不重置，所以用 globalThis 挂载。

import type { PlanStateRepo, BookingRepo, UserProfileRepo } from "./types";
import {
  createFilePlanStateRepo,
  createFileBookingRepo,
  createFileUserProfileRepo,
} from "./file-repos";
import {
  createPgPlanStateRepo,
  createPgBookingRepo,
  createPgUserProfileRepo,
} from "./pg-repos";

declare global {
  // eslint-disable-next-line no-var
  var __storageCache: {
    planStateRepo?: PlanStateRepo;
    bookingRepo?: BookingRepo;
    userProfileRepo?: UserProfileRepo;
    backend?: string;
  } | undefined;
}

function getBackend(): "file" | "postgres" {
  return process.env.STORAGE_BACKEND === "postgres"
    ? "postgres"
    : "file";
}

export { getBackend as getStorageBackend };

function ensureCache() {
  if (!globalThis.__storageCache || globalThis.__storageCache.backend !== getBackend()) {
    globalThis.__storageCache = { backend: getBackend() };
  }
}

export function getPlanStateRepo(): PlanStateRepo {
  ensureCache();
  if (!globalThis.__storageCache!.planStateRepo) {
    globalThis.__storageCache!.planStateRepo =
      getBackend() === "postgres"
        ? createPgPlanStateRepo()
        : createFilePlanStateRepo();
  }
  return globalThis.__storageCache!.planStateRepo;
}

export function getBookingRepo(): BookingRepo {
  ensureCache();
  if (!globalThis.__storageCache!.bookingRepo) {
    globalThis.__storageCache!.bookingRepo =
      getBackend() === "postgres"
        ? createPgBookingRepo()
        : createFileBookingRepo();
  }
  return globalThis.__storageCache!.bookingRepo;
}

export function getUserProfileRepo(): UserProfileRepo {
  ensureCache();
  if (!globalThis.__storageCache!.userProfileRepo) {
    globalThis.__storageCache!.userProfileRepo =
      getBackend() === "postgres"
        ? createPgUserProfileRepo()
        : createFileUserProfileRepo();
  }
  return globalThis.__storageCache!.userProfileRepo;
}
