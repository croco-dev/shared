import type { PageRouteDefinition } from "@croco/meta-vite";

/** Canonical page options aligned with the meta-vite route contract. */
export type CanonicalCrocoPageOptions = Partial<Pick<PageRouteDefinition, "head" | "path">> & {
  /** Rendering mode for the page route. */
  mode?: PageRouteDefinition["mode"];
  /** ISR revalidation interval in seconds. */
  revalidateSeconds?: PageRouteDefinition["revalidate"];
  ssr?: never;
  revalidate?: never;
};

/** Deprecated page options retained for migration to the canonical route contract. */
export type LegacyCrocoPageOptions = Partial<Pick<PageRouteDefinition, "head" | "path">> & {
  mode?: never;
  revalidateSeconds?: never;
  /** @deprecated Use `mode: "ssr"` or `mode: "ssg"`. */
  ssr?: boolean;
  /** @deprecated This value is milliseconds. Use `revalidateSeconds` instead. */
  revalidate?: number;
};

/** Page configuration accepted by {@link createCrocoPageConfig}. */
export type CrocoPageOptions = CanonicalCrocoPageOptions | LegacyCrocoPageOptions;

export type CrocoPageConfig = Required<Pick<PageRouteDefinition, "mode">> &
  Partial<Pick<PageRouteDefinition, "head" | "path" | "revalidate">>;

export function createCrocoPageConfig(
  options: CrocoPageOptions & Required<Pick<PageRouteDefinition, "path">>,
): CrocoPageConfig & Required<Pick<PageRouteDefinition, "path">>;
export function createCrocoPageConfig(options?: CrocoPageOptions): CrocoPageConfig;
export function createCrocoPageConfig(options?: CrocoPageOptions): CrocoPageConfig {
  const revalidate =
    options?.revalidateSeconds ??
    (options?.revalidate !== undefined ? options.revalidate / 1000 : undefined);

  return {
    mode:
      options?.mode ?? (revalidate !== undefined ? "isr" : options?.ssr === false ? "ssg" : "ssr"),
    ...(options?.path !== undefined ? { path: options.path } : {}),
    ...(options?.head !== undefined ? { head: options.head } : {}),
    ...(revalidate !== undefined ? { revalidate } : {}),
  };
}
