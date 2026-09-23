/** Load screenshot-only dependencies from the isolated tooling package. */

const SETUP_COMMAND = "npm run screenshots:setup";

/**
 * Load a screenshot tool and select its public API.
 *
 * @template Tool
 * @param {string} name - Package specifier to import.
 * @param {(module: Record<string, unknown>) => Tool} pick - Export selector.
 * @returns {Promise<Tool>}
 */
const loadTool = async (name, pick) => {
  try {
    const module = await import(name);
    return pick(module);
  } catch (error) {
    throw new Error(
      `Screenshot tooling is not installed. Run \`${SETUP_COMMAND}\` first.`,
      { cause: error },
    );
  }
};

/**
 * Load the Chromium API from the locally pinned Playwright package.
 *
 * @returns {Promise<import("playwright").BrowserType>}
 */
export const loadChromium = async () =>
  loadTool("playwright", ({ chromium }) => chromium);

/**
 * Load Sharp from the isolated screenshot tooling package.
 *
 * @returns {Promise<typeof import("sharp").default>}
 */
export const loadSharp = async () =>
  loadTool("sharp", ({ default: sharp }) => sharp);
