/// <reference types="vite/client" />

/**
 * The dev operator shell (see dev/bridge-plugin.ts). Resolves to no-op stubs
 * unless the dev server was started with APEX_BRIDGE set, and never exists at
 * all in a production build.
 */
declare module 'virtual:dev-bridge' {
  export const BRIDGE_ENABLED: boolean
  export function startDevBridge(): void
  export function registerBridgeContext(ctx: Record<string, unknown>): void
}
