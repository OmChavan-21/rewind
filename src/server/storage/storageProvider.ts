/**
 * Rewind Storage Provider Factory
 * Dynamically resolves the active storage provider:
 * - In Production (or when REWIND_STORAGE_PROVIDER === "cloud"), enforces CloudStorageAdapter (fails closed if unavailable).
 * - In Development / Tests, defaults to LocalStorageAdapter unless explicitly overridden.
 */

import type { IStorageProvider } from "./storageTypes";
import { StorageError } from "./storageTypes";
import { LocalStorageAdapter } from "./localStorageAdapter";
import { CloudStorageAdapter } from "./cloudStorageAdapter";

let testStorageProviderOverride: IStorageProvider | null = null;

export function setStorageProviderForTesting(provider: IStorageProvider | null): void {
  testStorageProviderOverride = provider;
}

/**
 * Returns whether cloud durable storage is required by the current environment.
 * Production environments strictly require cloud storage unless local storage is explicitly allowed.
 */
export function isCloudStorageRequired(): boolean {
  if (
    process.env.REQUIRE_CLOUD_STORAGE === "true" ||
    process.env.REWIND_STORAGE_PROVIDER === "cloud"
  ) {
    return true;
  }
  if (
    process.env.NODE_ENV === "production" &&
    process.env.REWIND_ALLOW_LOCAL_STORAGE_IN_PROD !== "true"
  ) {
    return true;
  }
  return false;
}

/**
 * Resolves the active storage provider.
 * Fails closed if cloud storage is required but unconfigured.
 */
export function getStorageProvider(storeRoot?: string): IStorageProvider {
  if (testStorageProviderOverride) {
    return testStorageProviderOverride;
  }

  if (isCloudStorageRequired()) {
    return new CloudStorageAdapter();
  }

  return new LocalStorageAdapter(storeRoot);
}

export { StorageError };
export type { IStorageProvider };
