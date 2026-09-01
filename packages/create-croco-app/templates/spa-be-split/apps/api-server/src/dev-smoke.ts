import { createCrocoApp } from "./app";

async function main(): Promise<void> {
  const app = createCrocoApp();
  try {
    const response = await app.fetch(new Request("http://localhost/users"));

    if (response.status !== 200) {
      throw new Error(`Expected /users to return 200, got ${response.status}`);
    }

    const users = (await response.json()) as Array<{ id: string; name: string }>;

    if (!users.some((user) => user.id === "user-1" && user.name === "Ada Lovelace")) {
      throw new Error("Expected seeded user data from the development API app");
    }

    console.log("api-server dev smoke passed");
  } finally {
    await app.disposeApplicationRuntime();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
