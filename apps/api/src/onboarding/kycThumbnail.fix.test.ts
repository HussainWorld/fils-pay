import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { generateKycThumbnail } from "./kycThumbnail.js";

test("a small-on-disk but huge-in-pixels PNG is rejected before decoding", async () => {
  // 9000 x 9000 = 81 MP solid colour: compresses to a few hundred KB
  const bomb = await sharp({ create: { width: 9000, height: 9000, channels: 3, background: "#ffffff" } })
    .png({ compressionLevel: 9 })
    .toBuffer();
  assert.ok(bomb.length < 8 * 1024 * 1024, "fits under the 8 MiB upload cap");
  await assert.rejects(() => generateKycThumbnail(bomb, "png"), /image_dimensions_too_large/);
});

test("a normal photo still gets a thumbnail", async () => {
  const photo = await sharp({ create: { width: 1200, height: 900, channels: 3, background: "#336699" } }).jpeg().toBuffer();
  const thumb = await generateKycThumbnail(photo, "jpeg");
  assert.ok(thumb && thumb.buffer.length > 0);
});
