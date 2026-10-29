import { UnprocessableEntityError } from "../lib/errors.js";
import sharp from "sharp";
import type { DetectedFileType } from "./fileSignature.js";

/**
 * Longest side, in pixels.
 */
const THUMBNAIL_MAX_DIMENSION_PX = 320;

export interface GeneratedThumbnail {
  buffer: Buffer;
  mimeType: string;
}

/**
 * Generates a review-UI-sized thumbnail from an already-validated upload
 * buffer. Only `jpeg`/`png` documents get one — a `pdf` (commercial
 * registration, bank letter) has no image to thumbnail, and this returns
 * `null` rather than attempting a PDF-to-image conversion. Always
 * re-encodes to JPEG regardless of the source format, so the admin
 * console's `<img>` tag never needs to branch on thumbnail mime type the
 * way the original-file endpoint does.
 */
export async function generateKycThumbnail(
  buffer: Buffer,
  detectedType: DetectedFileType,
): Promise<GeneratedThumbnail | null> {
  if (detectedType !== "jpeg" && detectedType !== "png") {
    return null;
  }
  // YA: the 8 MiB upload cap protects us here
  // FH: sharp's default pixel limit is ~268MP, a tiny png can decode huge. copilot suggests limitInputPixels
  // FIX (note: "has anyone tried uploading a really large ..."): the 8 MiB
  // cap limits the COMPRESSED size only. A PNG of a few KB can declare e.g.
  // 16000x16000 pixels; sharp's default limit (~268 MP) lets it decode to
  // ~1 GB of raw pixels, which kills the API's 512 MB container. A KYC
  // scan never needs more than ~40 MP, so refuse anything bigger before
  // decoding (sharp throws, and the upload is rejected).
  let resized: Buffer;
  try {
    resized = await sharp(buffer, { limitInputPixels: 40_000_000 })
      .resize(THUMBNAIL_MAX_DIMENSION_PX, THUMBNAIL_MAX_DIMENSION_PX, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 70 })
      .toBuffer();
  } catch {
    throw new UnprocessableEntityError("image_dimensions_too_large");
  }
  return { buffer: resized, mimeType: "image/jpeg" };
}
