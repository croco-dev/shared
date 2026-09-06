import { createCloudflareWorkersHost } from "@croco/preset-cloudflare";
import type { CloudflareHostFetchHandler } from "@croco/preset-cloudflare";
import { createCrocoApp } from "./app";

async function initializeWorkerHost(): Promise<CloudflareHostFetchHandler> {
  const app = await createCrocoApp({ hostPlatform: "cloudflare-workers" });
  return createCloudflareWorkersHost(app);
}

let hostReady: Promise<CloudflareHostFetchHandler> | undefined;

const fetch: CloudflareHostFetchHandler = async (request, env, context) => {
  hostReady ??= initializeWorkerHost();
  const workerHost = await hostReady;
  return workerHost(request, env, context);
};

export default { fetch };
