import { createHash } from "node:crypto";
import { Container } from "@croco/framework-context";
import { InvalidKeyProblem, storageStreamFromBytes } from "@croco/storage-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CloudinaryProvider } from "../libs/CloudinaryProvider";

const config = { cloudName: "resource-test", apiKey: "test-key", apiSecret: "test-secret" };
const payload = new Uint8Array([0, 255, 13, 10, 128, 42]);
const cases = [
  {
    key: "files/report.pdf",
    resource: "raw",
    publicId: "files/report.pdf",
    contentType: "application/pdf",
  },
  {
    key: "files/archive.zip",
    resource: "raw",
    publicId: "files/archive.zip",
    contentType: "application/zip",
  },
  {
    key: "files/notes.txt",
    resource: "raw",
    publicId: "files/notes.txt",
    contentType: "text/plain",
  },
  {
    key: "files/data.bin",
    resource: "raw",
    publicId: "files/data.bin",
    contentType: "application/octet-stream",
  },
  {
    key: "files/clip.mp4",
    resource: "video",
    publicId: "files/clip.mp4",
    contentType: "video/mp4",
  },
  {
    key: "files/clip.mov",
    resource: "video",
    publicId: "files/clip.mov",
    contentType: "video/quicktime",
  },
  {
    key: "files/song.mp3",
    resource: "video",
    publicId: "files/song.mp3",
    contentType: "audio/mpeg",
  },
  {
    key: "files/song.wav",
    resource: "video",
    publicId: "files/song.wav",
    contentType: "audio/wav",
  },
  {
    key: "files/avatar.png",
    resource: "image",
    publicId: "files/avatar.png",
    contentType: "image/png",
  },
  {
    key: "files/avatar.jpg",
    resource: "image",
    publicId: "files/avatar.jpg",
    contentType: "image/jpeg",
  },
  { key: "files/avatar", resource: "image", publicId: "files/avatar", contentType: "image/png" },
] as const;

type StoredObject = { data: Uint8Array; publicId: string };

function useNamespaceBackend() {
  const objects = new Map<string, StoredObject>();
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (url.hostname === "api.cloudinary.com") {
      if (parts[2] === "resources") {
        const object = objects.get(`${parts[3]}:${parts.slice(5).join("/")}`);
        return object
          ? Response.json({ bytes: object.data.length, created_at: "2026-01-01T00:00:00Z" })
          : Response.json({ error: { message: "Resource not found" } }, { status: 404 });
      }
      const resource = parts[2];
      if (parts[3] === "upload") {
        const form = await new Response(init?.body, { headers: init?.headers }).formData();
        const publicId = String(form.get("public_id"));
        const file = form.get("file");
        if (file === null || typeof file === "string") throw new Error("Missing upload file");
        const data = new Uint8Array(await file.arrayBuffer());
        objects.set(`${resource}:${publicId}`, { data, publicId });
        return Response.json({ public_id: publicId });
      }
      if (parts[3] === "destroy") {
        const fields = new URLSearchParams(String(init?.body));
        const existed = objects.delete(`${resource}:${fields.get("public_id")}`);
        return Response.json({ result: existed ? "ok" : "not found" });
      }
    }
    if (
      url.hostname === "res.cloudinary.com" &&
      parts[0] === config.cloudName &&
      parts[2] === "upload"
    ) {
      const deliveryParts = parts.slice(3);
      if (deliveryParts[0]?.startsWith("s--")) deliveryParts.shift();
      if (/^v\d+$/.test(deliveryParts[0] ?? "")) deliveryParts.shift();
      const key = deliveryParts.join("/");
      const publicId = parts[1] === "video" ? key.replace(/\.[^/.]+$/, "") : key;
      const object = objects.get(`${parts[1]}:${publicId}`);
      return object
        ? new Response(new Uint8Array(object.data))
        : new Response(null, { status: 404 });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { objects, fetchMock };
}

describe("Cloudinary resource namespaces", () => {
  beforeEach(() => Container.reset());
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe.each(cases)("$key", ({ key, resource, publicId, contentType }) => {
    it.each(["bytes", "stream"])(
      "stores %s with the expected namespace and public ID",
      async (bodyType) => {
        const backend = useNamespaceBackend();
        const data = bodyType === "bytes" ? payload : storageStreamFromBytes(payload);
        await new CloudinaryProvider(config).put(key, data, { contentType });
        expect(backend.objects.get(`${resource}:${publicId}`)?.data).toEqual(payload);
      },
    );

    it("selects the namespace from the key when MIME is omitted", async () => {
      const backend = useNamespaceBackend();
      await new CloudinaryProvider(config).put(key, payload);
      expect(backend.objects.get(`${resource}:${publicId}`)?.data).toEqual(payload);
    });

    it("accepts application/octet-stream in the key namespace", async () => {
      const backend = useNamespaceBackend();
      await new CloudinaryProvider(config).put(key, payload, {
        contentType: "application/octet-stream",
      });
      expect(backend.objects.get(`${resource}:${publicId}`)?.data).toEqual(payload);
    });

    it("downloads bytes after provider reconstruction", async () => {
      useNamespaceBackend();
      await new CloudinaryProvider(config).put(key, payload, { contentType });
      await expect(new CloudinaryProvider(config).get(key)).resolves.toEqual(payload);
    });

    it("reads metadata after provider reconstruction", async () => {
      useNamespaceBackend();
      await new CloudinaryProvider(config).put(key, payload, { contentType });
      await expect(new CloudinaryProvider(config).getMetadata(key)).resolves.toMatchObject({
        size: payload.length,
      });
    });

    it("finds an existing object after provider reconstruction", async () => {
      useNamespaceBackend();
      await new CloudinaryProvider(config).put(key, payload, { contentType });
      await expect(new CloudinaryProvider(config).exists(key)).resolves.toBe(true);
    });

    it("deletes the uploaded object after provider reconstruction", async () => {
      const backend = useNamespaceBackend();
      await new CloudinaryProvider(config).put(key, payload, { contentType });
      await new CloudinaryProvider(config).delete(key);
      expect(backend.objects.has(`${resource}:${publicId}`)).toBe(false);
    });

    it("returns false after deleting the object", async () => {
      useNamespaceBackend();
      await new CloudinaryProvider(config).put(key, payload, { contentType });
      await new CloudinaryProvider(config).delete(key);
      await expect(new CloudinaryProvider(config).exists(key)).resolves.toBe(false);
    });

    it("generates a public URL that retrieves the uploaded object", async () => {
      useNamespaceBackend();
      await new CloudinaryProvider(config).put(key, payload, { contentType });
      const url = new CloudinaryProvider(config).getPublicUrl(key);
      expect(new URL(url).pathname).toContain(`/${resource}/upload/`);
      expect(new Uint8Array(await (await fetch(url)).arrayBuffer())).toEqual(payload);
    });

    it("generates a signed URL in the uploaded namespace", async () => {
      useNamespaceBackend();
      await new CloudinaryProvider(config).put(key, payload, { contentType });
      const url = await new CloudinaryProvider(config).getSignedUrl(key, { expiresIn: 60 });
      expect(new URL(url).pathname).toMatch(new RegExp(`/${resource}/upload/s--[^/]+--/`));
      expect(new Uint8Array(await (await fetch(url)).arrayBuffer())).toEqual(payload);
    });
  });

  it.each(cases.filter(({ resource, key }) => resource !== "image" || !key.includes(".")))(
    "issues a signed upload intent for $key in its resource namespace",
    async ({ key, resource, publicId }) => {
      vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
      const intent = await new CloudinaryProvider(config).getUploadIntent(key);
      const signature = createHash("sha1")
        .update(`public_id=${publicId}&timestamp=1800000000${config.apiSecret}`)
        .digest("hex");
      expect(intent).toMatchObject({
        uploadUrl: `https://api.cloudinary.com/v1_1/${config.cloudName}/${resource}/upload`,
        fields: { public_id: publicId, signature, timestamp: "1800000000", api_key: config.apiKey },
      });
      expect(intent.publicUrl).toBe(new CloudinaryProvider(config).getPublicUrl(key));
      expect(new URL(intent.publicUrl).pathname).toContain(`/${resource}/upload/`);
    },
  );

  it.each([
    ["files/clip.mp4", "files/clip.mp4.mp4"],
    ["files/clip.mov", "files/clip.mov.mov"],
    ["files/clip.MP4", "files/clip.MP4.mp4"],
    ["files/song.mp3", "files/song.mp3.mp3"],
    ["files/song.wav", "files/song.wav.wav"],
  ])("preserves the full public ID and appends the delivery format for %s", (key, deliveryKey) => {
    const url = new CloudinaryProvider(config).getPublicUrl(key);
    expect(new URL(url).pathname).toBe(`/resource-test/video/upload/v1/${deliveryKey}`);
  });

  describe("video keys sharing a basename", () => {
    const siblings = ["files/clip.mp4", "files/clip.mov", "files/clip.MP4"];

    beforeEach(async () => {
      useNamespaceBackend();
      for (const [index, key] of siblings.entries()) {
        await new CloudinaryProvider(config).put(key, new Uint8Array([index]), {
          contentType: "application/octet-stream",
        });
      }
    });

    it.each(siblings)("reads %s without another extension overwriting it", async (key) => {
      await expect(new CloudinaryProvider(config).get(key)).resolves.toEqual(
        new Uint8Array([siblings.indexOf(key)]),
      );
    });

    it.each(siblings)("deletes only %s while preserving sibling objects", async (key) => {
      await new CloudinaryProvider(config).delete(key);
      for (const sibling of siblings.filter((candidate) => candidate !== key)) {
        await expect(new CloudinaryProvider(config).get(sibling)).resolves.toEqual(
          new Uint8Array([siblings.indexOf(sibling)]),
        );
      }
      await expect(new CloudinaryProvider(config).exists(key)).resolves.toBe(false);
    });
  });

  it.each([
    ["files/report.PDF", "Application/PDF; charset=binary", "raw"],
    ["files/clip.MP4", "Video/MP4; codecs=avc1", "video"],
    ["files/song.WAV", "Audio/WAV; rate=44100", "video"],
  ])(
    "accepts case-insensitive MIME parameters for %s without changing its public ID",
    async (key, contentType, resource) => {
      const backend = useNamespaceBackend();
      await new CloudinaryProvider(config).put(key, payload, { contentType });
      expect(backend.objects.get(`${resource}:${key}`)?.data).toEqual(payload);
    },
  );

  it.each(["files/avatar.png", "files/avatar.jpg"])(
    "preserves image intent extension rejection for %s",
    async (key) => {
      await expect(new CloudinaryProvider(config).getUploadIntent(key)).rejects.toThrow(
        InvalidKeyProblem,
      );
    },
  );

  it.each([
    ["files/report.pdf", "image/png"],
    ["files/report.pdf", "video/mp4"],
    ["files/clip.mp4", "application/pdf"],
    ["files/clip.mp4", "image/png"],
    ["files/avatar.png", "application/pdf"],
    ["files/avatar", "audio/mpeg"],
  ])("rejects %s with mismatched %s before consuming the stream", async (key, contentType) => {
    const { fetchMock } = useNamespaceBackend();
    const pull = vi.fn((controller: ReadableStreamDefaultController<Uint8Array>) => {
      controller.enqueue(payload);
      controller.close();
    });
    const stream = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 });
    await expect(
      new CloudinaryProvider(config).put(key, stream, { contentType }),
    ).rejects.toMatchObject({ code: "storage-cloudinary/validation-failed" });
    expect(pull).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
