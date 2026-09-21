import js from "@eslint/js";
import html from "@html-eslint/eslint-plugin";
import globals from "globals";

const styleRules = {
  "no-var": "error",
  "prefer-const": "error",
  "prefer-template": "error",
  "no-object-constructor": "error",
  "no-array-constructor": "error",
};

export default [
  {
    ignores: ["node_modules/**", "static/icons/**", "static/js/vendor/**"],
  },
  {
    files: ["static/js/**/*.js"],
    languageOptions: {
      sourceType: "module",
      globals: { ...globals.browser, Chart: "readonly" },
    },
    rules: { ...js.configs.recommended.rules, ...styleRules },
  },
  {
    // The one non-module under static/js/: it is loaded with a plain <script>
    // tag so it runs before the first paint (see its docstring). Listed after
    // the block above so its sourceType wins.
    files: ["static/js/boot-view.js"],
    languageOptions: { sourceType: "script" },
  },
  {
    files: ["static/sw.js"],
    languageOptions: {
      sourceType: "script",
      globals: { ...globals.serviceworker, ...globals.browser },
    },
    rules: { ...js.configs.recommended.rules, ...styleRules },
  },
  {
    files: ["eslint.config.js", "vitest.config.js"],
    languageOptions: {
      sourceType: "module",
      globals: { ...globals.node },
    },
  },
  {
    // Node-side tooling (screenshot capture, heading check). Run directly with
    // `node`, so they get the Node globals rather than the browser ones.
    files: ["scripts/**/*.{js,mjs}"],
    languageOptions: {
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: { ...js.configs.recommended.rules, ...styleRules },
  },
  {
    // Vitest globals (describe/it/expect/vi) are imported explicitly in each
    // test file, so only node + browser globals are needed here. The suites run
    // under happy-dom, hence the browser globals for window/document.
    files: ["tests/frontend/**/*.js"],
    languageOptions: {
      sourceType: "module",
      globals: { ...globals.node, ...globals.browser },
    },
    rules: { ...js.configs.recommended.rules, ...styleRules },
  },
  {
    ...html.configs["flat/recommended"],
    files: ["templates/**/*.html"],
    rules: {
      ...html.configs["flat/recommended"].rules,
      // Formatting is owned by Prettier; disable @html-eslint's stylistic rules.
      "@html-eslint/indent": "off",
      "@html-eslint/quotes": "off",
      "@html-eslint/element-newline": "off",
      "@html-eslint/attrs-newline": "off",
      "@html-eslint/no-extra-spacing-tags": "off",
      // The template self-closes void elements (XHTML style); accept that.
      "@html-eslint/require-closing-tags": ["error", { selfClosing: "always" }],
      // The PWA intentionally uses modern features (manifest, theme-color, datalist).
      "@html-eslint/use-baseline": "off",
      // Catch within-partial heading skips at lint time; cross-partial continuity
      // is enforced by scripts/check-heading-levels.mjs (npm run lint:headings).
      "@html-eslint/no-skip-heading-levels": "error",
    },
  },
  {
    // Partials are document fragments, not full pages, so the document-scope
    // rules (doctype/lang/title) don't apply. Everything else cascades from the
    // templates/**/*.html block above — including no-skip-heading-levels, which
    // catches heading skips within a single fragment. Continuity across
    // {% include %} boundaries is checked by scripts/check-heading-levels.mjs
    // (npm run lint:headings).
    files: ["templates/partials/**/*.html"],
    rules: {
      "@html-eslint/require-doctype": "off",
      "@html-eslint/require-lang": "off",
      "@html-eslint/require-title": "off",
    },
  },
];
