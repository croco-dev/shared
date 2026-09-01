import { createNodeHost } from "@croco/preset-node";
import { createCrocoApp } from "./app";
import { InvalidPortProblem } from "./problems";

function parsePort(value: string | undefined): number {
  const port = Number(value ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new InvalidPortProblem(value);
  }

  return port;
}

async function main(): Promise<void> {
  const port = parsePort(process.env.PORT);
  const app = await createCrocoApp({ profileMode: "production" });
  const host = createNodeHost(app.getHono(), { port });
  await host.start();
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
