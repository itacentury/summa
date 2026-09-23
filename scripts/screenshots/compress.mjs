/** Compress generated screenshots with the pinned Sharp installation. */

import { readFile, writeFile } from "node:fs/promises";

import { loadSharp } from "./dependencies.mjs";

/**
 * Quantize PNG screenshots and keep the smaller representation.
 *
 * @param {string[]} files - PNG files to process in place.
 * @returns {Promise<{ processed: number, replaced: number }>}
 */
export const compressScreenshots = async (files) => {
  const sharp = await loadSharp();
  let replaced = 0;

  for (const file of files) {
    const source = await readFile(file);
    const compressed = await sharp(source)
      .png({ palette: true, colours: 256, effort: 10 })
      .toBuffer();
    if (compressed.length >= source.length) continue;

    await writeFile(file, compressed);
    replaced += 1;
  }

  return { processed: files.length, replaced };
};
