# Code Style

Style conventions for this repository. These apply on every machine and do not depend on a global Claude configuration.

## Project-specific rules (non-obvious — read these first)

These are the rules that are **not** auto-enforced by the toolchain (`ruff`, `eslint` incl. `@html-eslint`, `stylelint`, `prettier`) and are not standard language idiom. Everything below this block (`## Python` onwards) is the full human-oriented language reference; most of it is enforced automatically. The HTML/CSS rules live entirely in this block (there is no separate HTML/CSS reference section below) — many of them (no `!important`, no `id` selectors, value hygiene, declaration order) are now enforced by `stylelint`/`@html-eslint`; the rest (semantic HTML, the `data-el` convention, the _intent_ behind logical grouping) remain human-checked.

**Engineering principles**

- **Do not touch unrelated code.**
- Prefer pure functions: output depends solely on input, no side effects, where feasible.
- Break code into small, focused, reusable functions or modules.
- Use early returns where they improve readability and reduce nesting.
- **Comments:** explain "why", not "what", used sparingly and only when non-obvious. Only document what is not obvious.

**Python**

- **Annotate all local variables**, not just parameters and return types (`count: int = 0`). Always specify type parameters for generics; otherwise they default to `Any`.
- **Comprehensions:** no multiple `for` clauses or filter expressions — optimize for readability, not conciseness.
- **Lambdas:** if the body spans multiple lines or exceeds ~60–80 chars, use a named nested function instead.
- **Ternaries:** only when each of the true / `if` / else parts fits on one line; otherwise use a full `if`.
- **Naming:** never abbreviate by deleting letters within a word; avoid ambiguous abbreviations.
- **Docstrings:** minimal Sphinx-style for modules, classes, and functions.

**JavaScript**

- **Optional destructured array parameter** defaults to `[]`, with element defaults on the left-hand side.
- No non-numeric properties on arrays (other than `length`) — use a `Map` or object instead.

**HTML / CSS**

- **Scripting/styling hooks:** use a `data-el="name"` hook (selected via `document.querySelector('[data-el="name"]')`) instead of an `id`, and avoid `id` selectors in CSS. Keep a (hyphenated) `id` only where the platform requires it — ARIA relationship attributes (`aria-labelledby`, `aria-controls`, `aria-activedescendant`) and in-page anchors (`href="#…"`, e.g. a skip link) reference targets by `id`; that is an intended use, not a violation of "avoid id".
- **Semantic HTML:** use elements for their purpose (heading elements for headings, `p` for paragraphs, `a` for anchors, …).
- **Template comments:** use an HTML comment (`<!-- … -->`) only for section labels; put developer-facing "why" notes in a Jinja comment (`{# … #}`) so they are stripped at render time instead of shipped to every client.
- **Class names:** meaningful or generic, as short as possible but as long as necessary, separated by hyphens (kebab-case); don't qualify them with type selectors.
- **CSS declaration order:** group related properties logically (box model → layout → visual detail) so a rule reads top-down, with section comments between larger groups — not alphabetical.
- **No `!important`** — override via selector specificity instead.
- **CSS value hygiene:** prefer shorthand properties; omit the unit on `0` values; keep leading zeros (`0.5`, not `.5`); use 3-character hex where possible.

## Python

- Use `pathlib` instead of `os.path`.
- Keep imports at module top level.
- Add explicit type annotations everywhere possible — including local variables (`count: int = 0`, not just parameters and return types). For generic types, always specify type parameters; otherwise they default to `Any`.
- Prefer `dataclass` or Pydantic models over untyped dictionaries where appropriate.
- Write minimal Sphinx-style docstrings for modules, classes, and functions.
- Prefer explicit exception handling over silent failures; catch specific exceptions.
- Prioritize readability, simplicity, and the Pythonic way.
- Use list comprehensions for concise list construction, but no multiple `for` clauses or filter expressions — optimize for readability, not conciseness.
- Use generators to iterate without holding the whole sequence in memory.
- Avoid mutable global state.
- Nested local functions/classes are fine when closing over a local variable; inner classes are fine.
- Lambdas are allowed; if the body spans multiple lines or exceeds ~60–80 chars, use a named nested function instead.
- Conditional (ternary) expressions are fine for simple cases — each of the true / `if` / else parts must fit on one line. Use a full `if` statement when it gets more complicated.
- Use decorators judiciously, only with a clear advantage. Avoid `staticmethod`; limit `classmethod`.
- Avoid "power features" (custom metaclasses, bytecode access, dynamic inheritance, reflection).
- Use `from __future__ import ...` to adopt modern syntax early; remove once the minimum supported Python version no longer needs it.
- Names are descriptive (functions, classes, variables, files, …). Avoid ambiguous abbreviations and never abbreviate by deleting letters within a word.
- Use getters/setters only when they carry meaningful behavior or non-trivial cost.
- Use parentheses sparingly: not in `return`/conditional statements unless for line continuation or to denote a tuple.

## JavaScript

- Use arrow functions for anonymous functions and callbacks, or to preserve lexical `this`.
- Prefer `const`; use `let` only for variables that are reassigned.
- Wrap async logic in `try`/`catch` so errors in asynchronous operations don't go uncaught; embrace Promises and `async`/`await`.
- Prefer template literals over string concatenation, especially when interpolating variables/expressions or building multi-line strings.
- Use destructuring to extract object/array properties succinctly, especially in function parameters; for an optional destructured array parameter default to `[]` and put element defaults on the left-hand side.
- Use the spread operator (`...`) to combine/clone arrays and objects; use rest parameters to collect variadic arguments into an array.
- Declare local variables close to first use to minimize scope, and initialize them as soon as possible.
- Do not put non-numeric properties on an array (other than `length`); use a `Map` or object instead.
- Use an object literal (`{}`) instead of `new Object()`.
- For named nested functions, assign the function to a local `const`.
- Generators may be used where they enable a useful abstraction.
