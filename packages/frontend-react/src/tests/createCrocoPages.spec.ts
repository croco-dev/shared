import { describe, expect, expectTypeOf, it } from "vitest";

import {
  RouteRegistry,
  createMetaViteRouteManifestFromRegistry,
  defineRoute,
} from "@croco/meta-vite";

import { createCrocoPageConfig } from "../libs/createCrocoPages";
import type { CrocoPageConfig, CrocoPageOptions } from "../libs/createCrocoPages";

describe("createCrocoPageConfig", () => {
  it("canonical options cannot be mixed with deprecated options", () => {
    // @ts-expect-error Canonical mode and deprecated ssr cannot be combined.
    createCrocoPageConfig({ mode: "ssr", ssr: true });
    // @ts-expect-error Canonical seconds and deprecated millisecond revalidate cannot be combined.
    createCrocoPageConfig({ mode: "isr", revalidate: 60_000, revalidateSeconds: 60 });
    // @ts-expect-error Canonical mode requires the explicitly named seconds option.
    createCrocoPageConfig({ mode: "isr", revalidate: 60 });
  });

  it("기본값 확인 - ssr mode", () => {
    const config = createCrocoPageConfig();

    expect(config.mode).toBe("ssr");
  });

  it.each(["ssr", "ssg", "isr", "rsc"] as const)("%s mode를 registry 경계까지 보존한다", (mode) => {
    const path = `/${mode}`;
    const registry = new RouteRegistry();
    const config = createCrocoPageConfig({ mode, path });

    registry.register(defineRoute({ ...config, component: () => null }));

    expect(config.mode).toBe(mode);
    expect(registry.getPageRoutes()).toEqual([expect.objectContaining({ mode, path })]);
  });

  it.each([
    [{ revalidateSeconds: 60 }, 60],
    [{ revalidateSeconds: 0 }, 0],
    [{ revalidate: 60_000 }, 60],
    [{ revalidate: 0 }, 0],
    [{ revalidate: 60_000, ssr: true }, 60],
    [{ revalidate: 60_000, ssr: false }, 60],
  ] satisfies [CrocoPageOptions, number][])(
    "revalidation 입력 %j에서 ISR을 추론한다",
    (options, seconds) => {
      const config = createCrocoPageConfig(options);

      expect(config.mode).toBe("isr");
      expect(config.revalidate).toBe(seconds);
    },
  );

  it.each(["ssr", "ssg", "isr", "rsc"] as const)(
    "revalidation이 있어도 명시한 %s mode를 보존한다",
    (mode) => {
      expect(createCrocoPageConfig({ mode, revalidateSeconds: 60 })).toEqual({
        mode,
        revalidate: 60,
      });
    },
  );

  it.each([
    [{ ssr: false }, "ssg"],
    [{ ssr: true }, "ssr"],
    [{ revalidateSeconds: undefined }, "ssr"],
    [{ revalidate: undefined }, "ssr"],
  ] satisfies [CrocoPageOptions, string][])(
    "revalidation이 없는 %j 입력의 기존 mode를 보존한다",
    (options, mode) => {
      expect(createCrocoPageConfig(options)).toEqual({ mode });
    },
  );

  it("path와 canonical head metadata를 보존한다", () => {
    const head = () => ({
      canonical: "https://example.com/dashboard",
      description: "desc",
      ogTitle: "Dashboard",
      title: "Test",
    });
    const config = createCrocoPageConfig({ head, path: "/dashboard" });
    const registry = new RouteRegistry();

    registry.register(defineRoute({ ...config, component: () => null }));
    const [route] = registry.getPageRoutes();

    expect(config.path).toBe("/dashboard");
    expect(config.head).toBe(head);
    expect(route?.head).toBe(head);
    expect(route?.head?.()).toEqual({
      canonical: "https://example.com/dashboard",
      description: "desc",
      ogTitle: "Dashboard",
      title: "Test",
    });
  });

  it("명시적인 초 단위 revalidate를 registry 경계에서 한 번만 변환한다", () => {
    const registry = new RouteRegistry();
    const config = createCrocoPageConfig({
      path: "/blog",
      revalidateSeconds: 60,
    });

    registry.register(
      defineRoute({ ...config, component: () => null, componentRef: "./blog.tsx" }),
    );

    expect(config.revalidate).toBe(60);
    expect(registry.getPageRoutes()).toEqual([
      expect.objectContaining({
        mode: "isr",
        path: "/blog",
        revalidateMs: 60_000,
      }),
    ]);
    expect(
      createMetaViteRouteManifestFromRegistry({ routeRegistry: registry }).pages[0],
    ).toMatchObject({
      mode: "isr",
      revalidateMs: 60_000,
      runtimeCapabilities: expect.arrayContaining(["isr-cache"]),
      runtimeRequirements: [
        {
          code: "CROCO_META_VITE_ISR_CACHE_REQUIRED",
          capability: "isr-cache",
          phase: "runtime",
          revalidateMs: 60_000,
        },
      ],
    });
  });

  it("deprecated boolean과 millisecond 입력을 canonical route config로 변환한다", () => {
    const config = createCrocoPageConfig({ path: "/legacy", revalidate: 60_000, ssr: false });

    expect(config).toEqual({ mode: "isr", path: "/legacy", revalidate: 60 });
  });

  it("meta-vite page route input과 직접 조합되는 config를 반환한다", () => {
    const config = createCrocoPageConfig({ mode: "rsc", path: "/dashboard" });

    expectTypeOf(config).toMatchTypeOf<CrocoPageConfig>();
    expect(defineRoute({ ...config, component: () => null })).toMatchObject({
      mode: "rsc",
      path: "/dashboard",
    });
  });
});
