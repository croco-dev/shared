import { createCloudflareWorkersHost } from "@croco/preset-cloudflare";
import { createCrocoApp } from "./app";

const app = createCrocoApp();
const fetch = createCloudflareWorkersHost(app);

export default { fetch };
