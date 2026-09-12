/**
 * Cross-partial heading-level continuity check.
 *
 * `@html-eslint`'s `no-skip-heading-levels` runs on each Jinja partial in
 * isolation, so it catches skips within a fragment but cannot see heading order
 * across `{% include %}` boundaries. This script assembles the partials in the
 * order `templates/index.html` includes them and verifies that heading levels
 * never jump by more than one (and that the document starts at h1), extending the
 * within-fragment guarantee across the whole assembled document.
 *
 * Both comment forms are stripped before scanning: a Jinja comment (`{# … #}`)
 * is gone after rendering, and an HTML comment (`<!-- … -->`) survives rendering
 * but is never parsed as markup by the browser — so a heading inside either form
 * is not a real heading. (Jinja still executes an `{% include %}` inside an HTML
 * comment; its output just lands inside the comment, contributing no headings.)
 *
 * Assumes a flat structure: only includes named directly in index.html are
 * scanned (no recursion into nested includes), and headings written directly in
 * index.html itself are ignored. Both hold today (leaf partials, heading-free
 * shell); revisit if partials start including sub-partials.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const templatesDir = join(projectRoot, "templates");
const entryTemplate = join(templatesDir, "index.html");

const includePattern = /{%-?\s*include\s+["']([^"']+)["'][^%]*%}/g;
const commentPattern = /<!--[\s\S]*?(?:-->|$)|{#[\s\S]*?(?:#}|$)/g;
const headingPattern = /<h([1-6])\b/gi;

/**
 * Read a template and return the partial paths it includes, in source order.
 */
const collectIncludes = (templatePath) => {
  const source = readFileSync(templatePath, "utf8").replace(commentPattern, "");
  const includes = [];
  for (const match of source.matchAll(includePattern)) {
    includes.push(match[1]);
  }
  return includes;
};

/**
 * Read a partial and return its heading levels in document order, tagging each
 * with its source file for actionable error messages.
 */
const collectHeadings = (relativePath) => {
  const source = readFileSync(join(templatesDir, relativePath), "utf8").replace(
    commentPattern,
    "",
  );
  const headings = [];
  for (const match of source.matchAll(headingPattern)) {
    headings.push({ level: Number(match[1]), file: relativePath });
  }
  return headings;
};

const headings = collectIncludes(entryTemplate).flatMap(collectHeadings);

let previousLevel = 0;
const violations = [];
for (const heading of headings) {
  if (heading.level - previousLevel > 1) {
    const from = previousLevel === 0 ? "document start" : `h${previousLevel}`;
    violations.push(
      `  ${heading.file}: jump from ${from} to h${heading.level}`,
    );
  }
  previousLevel = heading.level;
}

if (violations.length > 0) {
  console.error("Heading-level continuity violations (assembled document):");
  console.error(violations.join("\n"));
  process.exit(1);
}
