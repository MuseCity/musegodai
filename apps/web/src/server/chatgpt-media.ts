import { z } from "zod";
import { imageSize } from "image-size";
import { imageLimit, type ImagePurpose } from "../shared/images";
import { ApiError, requireValue } from "./errors";
import {
  boundedBody,
  createUpload,
  uploadBytes,
  completeUpload,
  type ObjectStore,
} from "./media";
import { inputInfo, type ImageServices } from "./image-processing";
import type { Database } from "./database";
import type { Actor } from "./auth";

// All four properties are required by ChatGPT's fileParams schema contract.
export const chatgptFile = z
  .object({
    download_url: z.string().max(8192),
    file_id: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[a-zA-Z0-9_-]+$/),
    mime_type: z.string().max(100).optional(),
    file_name: z.string().max(300).optional(),
  })
  .strict();

function fileUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ApiError(
      400,
      "INVALID_FILE_SOURCE",
      "Attach an image through ChatGPT's supported file input.",
    );
  }
  requireValue(
    url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      (!url.port || url.port === "443") &&
      (url.hostname === "oaiusercontent.com" ||
        url.hostname.endsWith(".oaiusercontent.com")),
    400,
    "INVALID_FILE_SOURCE",
    "Use a ChatGPT-hosted image attachment. This download host is not supported.",
  );
  url.hash = "";
  return url;
}

export async function importChatgptImage(
  db: Database,
  actor: Actor,
  store: ObjectStore,
  images: ImageServices | undefined,
  file: z.infer<typeof chatgptFile>,
  purpose: ImagePurpose,
) {
  let url = fileUrl(file.download_url);
  const signal = AbortSignal.timeout(15000);
  let bytes: ArrayBuffer | undefined;
  try {
    for (let hop = 0; hop <= 2; hop++) {
      // No Musegod credentials, cookies or caller headers are sent to storage.
      // The production Worker additionally enforces global_fetch_strictly_public.
      const response = await fetch(url, { redirect: "manual", signal });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get("location");
        requireValue(
          location && hop < 2,
          422,
          "FILE_UNAVAILABLE",
          "Reattach the image and try again.",
        );
        url = fileUrl(new URL(location, url).href);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new ApiError(
          422,
          "FILE_UNAVAILABLE",
          "The attachment expired or is unavailable. Reattach it and try again.",
        );
      }
      if (Number(response.headers.get("content-length") ?? 0) > imageLimit) {
        await response.body?.cancel();
        throw new ApiError(
          413,
          "FILE_TOO_LARGE",
          "The attachment is too large.",
        );
      }
      bytes = await boundedBody(response, imageLimit);
      break;
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    // Provider errors can contain the temporary URL. Never surface or log them.
    throw new ApiError(
      422,
      "FILE_UNAVAILABLE",
      "The attachment could not be downloaded. Reattach it and try again.",
    );
  }
  requireValue(
    bytes,
    422,
    "FILE_UNAVAILABLE",
    "Reattach the image and try again.",
  );
  let mimeType: string | undefined;
  try {
    mimeType = (
      { jpg: "image/jpeg", png: "image/png", webp: "image/webp" } as Record<
        string,
        string
      >
    )[imageSize(new Uint8Array(bytes)).type!];
  } catch {
    /* Actual bytes are checked below. */
  }
  requireValue(
    mimeType,
    422,
    "MEDIA_REJECTED",
    "Attach a complete JPEG, PNG or WebP image.",
  );
  inputInfo(bytes, mimeType);
  const upload = await createUpload(
    db,
    actor,
    mimeType,
    bytes.byteLength,
    purpose,
  );
  await uploadBytes(
    db,
    store,
    upload.mediaId,
    new Request("https://internal.invalid/upload", {
      method: "PUT",
      headers: {
        "Content-Type": mimeType,
        "X-Upload-Token": upload.uploadToken,
      },
      body: bytes,
    }),
    images,
  );
  return completeUpload(db, actor, upload.mediaId, store);
}
