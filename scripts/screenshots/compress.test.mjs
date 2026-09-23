/** Tests for deterministic screenshot compression. */

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import sharp from "sharp";

import { compressScreenshots } from "./compress.mjs";

test("compressScreenshots writes a smaller paletted PNG", async () => {
  const directory = await mkdtemp(join(tmpdir(), "summa-compress-test-"));
  const file = join(directory, "flat-ui.png");

  try {
    const source = await sharp({
      create: {
        width: 256,
        height: 256,
        channels: 4,
        background: { r: 18, g: 92, b: 74, alpha: 1 },
      },
    })
      .png({ palette: false, compressionLevel: 0 })
      .toBuffer();
    await writeFile(file, source);

    const result = await compressScreenshots([file]);
    const output = await readFile(file);
    const metadata = await sharp(output).metadata();

    assert.deepEqual(result, { processed: 1, replaced: 1 });
    assert.equal(metadata.format, "png");
    assert.equal(metadata.isPalette, true);
    assert.ok(output.length < source.length);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("compressScreenshots leaves an invalid source untouched", async () => {
  const directory = await mkdtemp(join(tmpdir(), "summa-compress-test-"));
  const file = join(directory, "invalid.png");
  const source = Buffer.from("not a png");

  try {
    await writeFile(file, source);

    await assert.rejects(compressScreenshots([file]));
    assert.deepEqual(await readFile(file), source);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
