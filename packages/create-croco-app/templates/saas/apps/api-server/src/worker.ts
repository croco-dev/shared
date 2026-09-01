import { createCloudflareWorkersHost } from "@croco/preset-cloudflare";
import { createCrocoApp } from "./app";

const app = createCrocoApp({ hostPlatform: "cloudflare-workers" });
const fetch = createCloudflareWorkersHost(app);

export default { fetch };
