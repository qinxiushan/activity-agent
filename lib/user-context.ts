import os from "node:os";
import { DEFAULT_USER_ID } from "./user-preferences";

export function getCurrentUserId(): string {
  return os.userInfo().username || DEFAULT_USER_ID;
}
