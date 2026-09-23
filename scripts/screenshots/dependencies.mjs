/** Load screenshot-only dependencies from the isolated tooling package. */

const SETUP_COMMAND = "npm run screenshots:setup";

/**
 * Load the Chromium API from the locally pinned Playwright package.
 *
 * @returns {Promise<import("playwright").BrowserType>}
 */
export const loadChromium = async () => {
  try {
    const { chromium } = await import("playwright");
    return chromium;
  } catch (error) {
    throw new Error(
      `Screenshot tooling is not installed. Run \`${SETUP_COMMAND}\` first.`,
      { cause: error },
    );
  }
};

/**
 * Load Sharp from the isolated screenshot tooling package.
 *
 * @returns {Promise<typeof import("sharp").default>}
 */
export const loadSharp = async () => {
  try {
    const { default: sharp } = await import("sharp");
    return sharp;
  } catch (error) {
    throw new Error(
      `Screenshot tooling is not installed. Run \`${SETUP_COMMAND}\` first.`,
      { cause: error },
    );
  }
};
