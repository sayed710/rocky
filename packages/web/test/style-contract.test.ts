import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Two levels up: the suite runs from `dist-test/test/`, not from source. Same as `a11y.test.ts`.
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CSS = readFileSync(resolve(PACKAGE_ROOT, 'src/style.css'), 'utf8');

const REVIEW_TONES = [
  'brilliant',
  'great',
  'excellent',
  'book',
  'inaccuracy',
  'mistake',
  'miss',
] as const;

interface Rule {
  readonly selectors: readonly string[];
  readonly body: string;
}

function stripCssComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Every top-level rule in the stylesheet, comments stripped. */
function rules(source = CSS): Rule[] {
  const stripped = stripCssComments(source);
  const out: Rule[] = [];
  for (const chunk of stripped.split('}')) {
    const brace = chunk.indexOf('{');
    if (brace === -1) continue;
    const head = chunk.slice(0, brace).trim();
    if (!head || head.startsWith('@')) continue;
    out.push({ selectors: head.split(',').map((s) => s.trim()).filter(Boolean), body: chunk.slice(brace + 1) });
  }
  return out;
}

/** Body of the first matching at-rule, accounting for nested declaration blocks. */
function atRuleBody(marker: string, source = CSS): string {
  const stripped = stripCssComments(source);
  const markerIndex = stripped.indexOf(marker);
  assert.notEqual(markerIndex, -1, `could not find ${marker}`);
  const open = stripped.indexOf('{', markerIndex);
  assert.notEqual(open, -1, `could not find the opening brace for ${marker}`);

  let depth = 1;
  let quote: "'" | '"' | undefined;
  let escaped = false;
  for (let index = open + 1; index < stripped.length; index += 1) {
    const character = stripped[index];
    if (quote !== undefined) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === quote) quote = undefined;
      continue;
    }
    if (character === "'" || character === '"') quote = character;
    else if (character === '{') depth += 1;
    else if (character === '}' && --depth === 0) return stripped.slice(open + 1, index);
  }
  throw new Error(`could not find the closing brace for ${marker}`);
}

/** Read one hexadecimal custom-property value from a declaration block. */
function hexProperty(body: string, name: string): string {
  const match = body.match(new RegExp(`--${name}\\s*:\\s*(#[0-9a-f]{6})`, 'i'));
  assert.ok(match, `missing hexadecimal --${name} token`);
  return match[1]!;
}

/** Convert an sRGB hexadecimal color into WCAG relative luminance. */
function luminance(hex: string): number {
  const channels = hex.slice(1).match(/../g)!.map((pair) => Number.parseInt(pair, 16) / 255);
  const [red, green, blue] = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
}

/** Return the WCAG contrast ratio between two opaque hexadecimal colors. */
function contrast(first: string, second: string): number {
  const firstLuminance = luminance(first);
  const secondLuminance = luminance(second);
  return (Math.max(firstLuminance, secondLuminance) + 0.05)
    / (Math.min(firstLuminance, secondLuminance) + 0.05);
}

test('at-rule parsing ignores braces in comments and quoted values', () => {
  const source = `@media (min-width: 720px) {
    /* A closing brace here must not terminate the at-rule: } */
    .label { content: "}"; }
    .target { inline-size: 100%; }
  }`;

  assert.match(atRuleBody('@media (min-width: 720px)', source), /\.target\s*\{\s*inline-size:\s*100%/);
});

test('Game Review classification tokens meet text contrast in both themes', () => {
  const root = rules().find((rule) => rule.selectors.includes(':root'));
  const explicitLight = rules().find((rule) => rule.selectors.includes(':root.light'));
  assert.ok(root, 'missing :root theme tokens');
  assert.ok(explicitLight, 'missing explicit light-theme tokens');

  for (const tone of REVIEW_TONES) {
    const darkColor = hexProperty(root.body, `review-${tone}`);
    const lightColor = hexProperty(root.body, `light-review-${tone}`);
    assert.ok(contrast(darkColor, '#242224') >= 4.5, `${tone} fails dark-theme contrast`);
    assert.ok(contrast(lightColor, '#F5F1ED') >= 4.5, `${tone} fails light-theme contrast`);
    const lightAssignment = new RegExp(`--review-${tone}\\s*:\\s*var\\(--light-review-${tone}\\)`);
    assert.match(explicitLight.body, lightAssignment);

    const selector = `.game-review-${tone} strong`;
    const toneRule = rules().find((rule) => rule.selectors.includes(selector));
    assert.ok(toneRule, `missing ${selector}`);
    assert.match(toneRule.body, new RegExp(`color\\s*:\\s*var\\(--review-${tone}\\)`));
  }

  const good = rules().find((rule) => rule.selectors.includes('.game-review-good strong'));
  assert.ok(good, 'missing .game-review-good strong');
  assert.match(good.body, /color\s*:\s*var\(--fg\)/);
});

const USES_BACKGROUND_SHORTHAND = /(^|[;\s])background\s*:/;

/**
 * Whether a selector can match a promotion-choice button. That element is
 * `<button class="cb-promo-choice cb-p-wq">`, so both a bare `button` selector and anything naming
 * `.cb-promo-choice` reach it — unless the selector explicitly excludes it.
 */
function canMatchPromoChoice(selector: string): boolean {
  if (selector.includes(':not(.cb-promo-choice)')) return false;
  const compound = selector.split(/\s+|>|\+|~/).filter(Boolean).pop() ?? '';
  return /^button([:.[]|$)/.test(compound) || compound.includes('.cb-promo-choice');
}

/**
 * The promotion picker draws its pieces with the shared `.cb-p-*` classes, which supply only a
 * `background-image`. Any rule matching the button that uses the `background` **shorthand** resets
 * that image to none, and the piece disappears.
 *
 * It happened twice, in two different ways, which is why this test asserts a property of the whole
 * stylesheet rather than of two named rules:
 *
 * 1. `.cb-promo-choice` set `background: var(--promo-tile)`. At equal specificity to `.cb-p-*` and
 *    later in the file, it won — so the dialog rendered four identical blank tiles.
 * 2. `button:not(:disabled):hover` set `background: var(--panel)`. At (0,2,1) it outranks `.cb-p-*`
 *    at (0,1,0), so the piece vanished on hover. The first version of this test missed it entirely,
 *    because it inspected the rules it knew the names of rather than every rule that can match the
 *    element. Found in the review of PR #98.
 *
 * Nothing else catches either one: the markup, the classes and the DOM are all correct, and the only
 * evidence is on screen. Collapsing several `background-*` declarations into one shorthand also looks
 * like a tidy-up, which is what makes it the likeliest regression here.
 */
test('no rule that can match a promotion tile uses the background shorthand', () => {
  const offenders: string[] = [];
  for (const rule of rules()) {
    if (!USES_BACKGROUND_SHORTHAND.test(rule.body)) continue;
    for (const selector of rule.selectors) {
      if (canMatchPromoChoice(selector)) offenders.push(selector);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `these rules match a promotion tile and use the background shorthand, which erases the piece: ${offenders.join(', ')}`,
  );
});

/** The rule the artwork actually depends on still has to set the colour it replaced. */
test('the promotion tile sets background-color at rest and on hover', () => {
  for (const selector of ['.cb-promo-choice', '.cb-promo-choice:hover']) {
    const rule = rules().find((r) => r.selectors.includes(selector));
    assert.ok(rule, `no rule found for ${selector}`);
    assert.ok(rule!.body.includes('background-color:'), `${selector} must set background-color`);
  }
});

/**
 * The artwork also needs sizing. `.cb-piece` carries that for pieces on the board, and the promotion
 * button is not a `.cb-piece`, so without these the SVG renders at its intrinsic size, anchored
 * top-left, and tiled.
 */
test('the promotion tile sizes and centres its piece artwork', () => {
  const rule = rules().find((r) => r.selectors.includes('.cb-promo-choice'));
  assert.ok(rule, 'no rule found for .cb-promo-choice');
  for (const declaration of ['background-size:', 'background-repeat:', 'background-position:']) {
    assert.ok(rule!.body.includes(declaration), `.cb-promo-choice must set ${declaration}`);
  }
});

/**
 * `class="auth"` sat in `index.html` with not one rule matching it anywhere in the stylesheet, so
 * the app's front door rendered as raw browser chrome in the page's top-left corner. Nothing caught
 * it: the markup was valid, the classes were spelled correctly, and every test was green — the only
 * evidence was on screen.
 *
 * This asserts the property that was actually violated: a class the markup carries has a rule.
 * Scoped to the surfaces this increment styled rather than every class in the document, because
 * some classes are behavioural hooks with nothing to style; growing the list is how a future
 * surface joins the guarantee.
 */
const STYLED_CLASSES = [
  'auth',
  'auth-form',
  'auth-field',
  'auth-field-full',
  'auth-actions',
  'auth-meta',
  'passkeys-actions',
];

test('every class the auth surface carries is matched by a rule', () => {
  const HTML = readFileSync(resolve(PACKAGE_ROOT, 'index.html'), 'utf8');
  const all = rules();
  for (const name of STYLED_CLASSES) {
    const usedInMarkup = new RegExp('class="[^"]*\\b' + name + '\\b');
    const namesTheClass = new RegExp('\\.' + name + '(?![\\w-])');
    assert.ok(
      usedInMarkup.test(HTML),
      `\`${name}\` is no longer used in index.html — drop it from STYLED_CLASSES`,
    );
    // The *last* compound, not anywhere in the selector: `.auth h2` mentions `.auth` while styling
    // the heading inside it, and would have let this test pass with the container itself unstyled.
    // Verified by deleting the `.auth` rule and watching this test go red.
    const stylesTheElement = all.some((rule) =>
      rule.selectors.some((s) => namesTheClass.test(s.split(/\s+|>|\+|~/).filter(Boolean).pop() ?? '')));
    assert.ok(
      stylesTheElement,
      `\`.${name}\` is in the markup but no rule targets the element itself — it renders as browser default`,
    );
  }
});

/** The rule carrying exactly this selector, or a failed assertion naming the one that went missing. */
function authRule(selector: string): Rule {
  const rule = rules().find((r) => r.selectors.includes(selector));
  assert.ok(rule, 'could not find the `' + selector + '` rule');
  return rule;
}

/**
 * The auth surface's layout contract, asserted as a property rather than a screenshot.
 *
 * The sign-in form and its action row have to reflow from the space they are actually given: a
 * fixed column count is what makes a layout need a media query, and a media query is what drifts
 * when the card's padding or measure changes. The minimum track is expressed in `rem` so the
 * columns collapse when the *text* outgrows them, not at a pixel width that assumes a default font
 * size.
 */
test('the auth grids size themselves from available space, not from a fixed column count', () => {
  for (const selector of ['#auth-form', '.auth-actions']) {
    const { body } = authRule(selector);
    assert.match(
      body,
      /grid-template-columns\s*:\s*repeat\(\s*auto-fit\s*,\s*minmax\(\s*[\d.]+rem\s*,\s*1fr\s*\)\s*\)/,
      selector + ' must size its tracks with auto-fit and a rem minimum, so it reflows without a breakpoint',
    );
  }
});

test('the shared auth form and action row are grids, so a single-control surface fills its row', () => {
  for (const selector of ['.auth-form', '.auth-actions']) {
    assert.match(authRule(selector).body, /display\s*:\s*grid/, selector + ' must be a grid');
  }
});

/**
 * The three sign-in buttons were `flex-wrap: wrap`, which sizes each one to its own label: "Sign
 * in", "Register" and "Sign in with passkey" came out three different widths and broke into a
 * ragged second row on the app's front door. The grid gives them one width; these are the two spans
 * that make the arrangement deliberate rather than incidental — the optional recovery email and the
 * default action each take the whole row, so Register and the passkey path pair off beneath it
 * instead of leaving a 2-1 split.
 */
test('the optional email field and the default action each span the sign-in form', () => {
  const spanned = rules()
    .filter((rule) => /grid-column\s*:\s*1\s*\/\s*-1/.test(rule.body))
    .flatMap((rule) => rule.selectors);
  for (const selector of ['#auth-form .auth-field-full', '#auth-form .auth-actions', '.auth-actions #auth-submit']) {
    assert.ok(spanned.includes(selector), '`' + selector + '` must span the full row');
  }
});

/**
 * A grid item's automatic minimum size is its content, and an input's content minimum comes from
 * the `size` attribute — 20 characters, roughly 180px. Two of those plus a gap exceed a 320px
 * phone, so without `min-width: 0` the fields refuse to shrink and the card overflows the viewport
 * horizontally instead of collapsing to one column. Asserted here because nothing catches it until
 * someone opens the app at 320px.
 */
test('auth fields can shrink below their inputs intrinsic width', () => {
  assert.match(authRule('.auth-field').body, /min-width\s*:\s*0/);
});

/**
 * The auth block is laid out for both writing directions. Physical placement (`float`, `left`,
 * `right`, `margin-left`/`margin-right`) would pin it to LTR; grid line numbers and logical
 * properties mirror themselves under `dir="rtl"`. `text-align` is in the list because it is the one
 * that gets added without thinking.
 */
test('the auth layout makes no physical-direction assumption', () => {
  const namesAuth = /(^|[\s,>+~])[.#]auth/;
  const physicalPlacement = /(^|[\s;{])(float|clear|text-align)\s*:|(margin|padding|border)-(left|right)\s*:|(^|[\s;])(left|right)\s*:/;
  for (const rule of rules()) {
    if (!rule.selectors.some((selector) => namesAuth.test(selector))) continue;
    assert.doesNotMatch(
      rule.body,
      physicalPlacement,
      '`' + rule.selectors.join(', ') + '` uses a physical direction — use a logical property so RTL mirrors',
    );
  }
});

/**
 * The retry button is the entire recovery path when verification fails transiently, and it is the
 * only control on that surface. The app's 44px touch target lives in `@media (pointer: coarse)`,
 * which a 390px-wide window on a mouse-driven machine does not match — the button rendered 36px
 * there, and only a browser run at that viewport could see it. Asserting the scoped rule here means
 * a CSS regression is caught by the unit suite instead of depending on Playwright alone.
 */
test('the email-verification retry control keeps a 44px touch target at every pointer type', () => {
  const retry = rules().find((rule) => rule.selectors.includes('#email-verify .auth-actions button'));
  assert.ok(retry, 'could not find the scoped email-verification retry rule');
  assert.match(retry.body, /min-height\s*:\s*44px/);
});

test('passkey management action is separated from the credential list by one spacing step', () => {
  const passkeysActions = rules().find((rule) => rule.selectors.includes('.passkeys-actions'));
  assert.ok(passkeysActions, 'could not find the passkeys actions rule');
  assert.match(passkeysActions.body, /margin-bottom\s*:\s*8px/);
});

/**
 * The design system has exactly one form-control treatment, and the way a second one appears is
 * someone styling a new input beside the shared rule instead of joining it. The auth inputs must
 * ride the same selector list as the nav search and the create-game fields.
 */
test('the auth inputs join the one shared form-control rule', () => {
  const shared = rules().find((r) =>
    r.selectors.includes('.nav-search input[type=\'search\']') && r.body.includes('border-radius'));
  assert.ok(shared, 'could not find the shared form-control rule to check against');
  assert.ok(
    shared.selectors.includes('.auth-field input'),
    'auth inputs must join the shared form-control rule, not carry a private treatment',
  );
});

/**
 * The board's height cap must come from the space actually left over, never from a number someone
 * wrote down for the chrome. The first version subtracted a hard-coded 96px and was wrong twice
 * over: `.topbar` carries `flex-wrap: wrap`, so a narrow window makes it two rows and the board
 * overflowed again on the screens with the least room; and on a short viewport the subtraction went
 * negative, which makes `max-width` invalid, so the cap was dropped entirely. Both found in the
 * review of PR #101.
 *
 * Asserting the absence of the estimate is the point — a future "let me just bump it to 120px" is
 * exactly the edit this is here to stop.
 */
test('the board fits the window without estimating the chrome height', () => {
  const board = rules().find((r) => r.selectors.includes('.cb-board'));
  assert.ok(board, 'no .cb-board rule');

  assert.ok(
    !/calc\(\s*100d?vh\s*-/.test(board.body),
    'the board cap must not subtract a fixed chrome height from the viewport — ' +
      'that estimate goes stale the moment the topbar wraps, and goes negative on a short window',
  );
  assert.ok(
    /(^|[;\s])width\s*:\s*100%/.test(board.body)
      && /(^|[;\s])height\s*:\s*auto/.test(board.body),
    'the mobile board must be width-driven so stacked game controls cannot collapse it',
  );

  // The cap only binds if the ancestors actually hand it a bounded height.
  const all = rules();
  const body = all.find((r) => r.selectors.includes('body'));
  assert.ok(body && /flex-direction:\s*column/.test(body.body), 'body must be a column');
  const game = all.find((r) => r.selectors.includes('.game') && r.body.includes('flex:'));
  assert.ok(game, '.game must take the height the topbar leaves');
  assert.ok(
    /min-height:\s*0/.test(game.body),
    'without min-height:0 a flex item will not shrink below its content, and the cap never binds',
  );

  /**
   * The half this test used to miss. Both the former percentage cap and the current container-height
   * unit need a parent whose height is *definite*; against a parent that only has `min-height`, the
   * board sizes to the parent while the parent sizes to the board, and neither ever gives. Every
   * assertion above passed while a 792px board hung 101px below the fold of a 767px window.
   *
   * So the assertion is on `height`, not `min-height`, and on the bootstrap-managed game-route
   * marker rather than a browser-dependent relational selector.
   */
  const desktop = rules(atRuleBody('@media (min-width: 720px)'));
  const boundsTheGameColumn = desktop.some((rule) =>
    rule.selectors.includes('body.route-game')
    && /(^|[;\s])height\s*:\s*100d?vh/.test(rule.body));
  assert.ok(
    boundsTheGameColumn,
    'the game route needs a definite `height` on the column, not just `min-height` — '
      + 'a `max-height: 100%` child resolves to nothing against a parent that can grow',
  );
  const desktopGame = desktop.find((rule) => rule.selectors.includes('.game'));
  assert.ok(desktopGame, 'the desktop breakpoint must define the board sizing container');
  assert.ok(
    /container-type\s*:\s*size/.test(desktopGame.body),
    'the game grid must expose both available axes so the board can use the smaller one',
  );
  const desktopBoard = desktop.find((rule) => rule.selectors.includes('.cb-board'));
  assert.ok(desktopBoard, 'the desktop breakpoint must size the board against its container');
  assert.ok(
    /(^|[;\s])width\s*:\s*min\(\s*100%\s*,\s*100cqh\s*\)/.test(desktopBoard.body)
      && /(^|[;\s])height\s*:\s*auto/.test(desktopBoard.body)
      && /align-self\s*:\s*start/.test(desktopBoard.body),
    'desktop must keep the board square using the smaller of its column width and available height',
  );
});

test('keyboard focus on a board square has a visible board-safe indicator', () => {
  const focus = rules().find((rule) => rule.selectors.includes('.cb-sq:focus-visible'));
  assert.ok(focus, 'board squares need an explicit focus-visible treatment');
  assert.match(focus.body, /outline\s*:/);
  assert.match(focus.body, /box-shadow\s*:/);
});

/**
 * `body` became a flex column in ADR-0104 so the board could be bounded by the height the topbar
 * leaves. That silently narrowed every centred content column in the app: a flex item with
 * `margin-inline: auto` loses the default stretch and falls back to shrink-to-fit, so a rule
 * reading `max-width: 600px` produced a column as wide as whatever happened to be inside it — the
 * lobby measured 389px. Nothing looked broken enough to name. The app just read as cramped, with
 * every section on its own width and nothing sharing a left edge.
 *
 * So the invariant is not "the lobby is 600px" but the property that failed: a rule that centres
 * itself with `margin: 0 auto` and caps itself with `max-width` must also claim the line with
 * `width`. Asserted across the stylesheet rather than for a list of known sections, because the way
 * this returns is a *new* section written in the old shape.
 *
 * The first version exempted any rule declaring `display: grid|flex`, on the reasoning that such a
 * rule sizes its own children. That is the wrong question, and it hid a live instance: `.game` is a
 * grid *and* a flex item of `body`, and measured 628px against its own 1100px cap on a 1482px
 * viewport. What a rule does to its children says nothing about whether the rule's own element
 * keeps its width. Raised in the review of PR #103; there is no exemption now.
 */
test('every centred content column claims its width, so flex layout cannot shrink it', () => {
  const all = rules();

  /**
   * Selectors reached by a rule that sets a width — including the shared rule several sections
   * join, which is why this is a set over every rule rather than a per-rule re-scan. Tolerant of
   * spacing (`width:100%`, a newline before the value) so a formatting change cannot turn the guard
   * red or, worse, green.
   */
  const DECLARES_WIDTH = /(^|[;{\s])width\s*:/;
  const widthBearingSelectors = new Set(
    all.filter((rule) => DECLARES_WIDTH.test(rule.body)).flatMap((rule) => rule.selectors),
  );

  const offenders = all
    .filter((rule) => {
      const centresItself = /margin(-inline)?\s*:\s*[^;]*\bauto\b/.test(rule.body);
      const capsItself = /max-width\s*:\s*\d/.test(rule.body);
      if (!centresItself || !capsItself) return false;
      return !rule.selectors.some((selector) => widthBearingSelectors.has(selector));
    })
    .map((rule) => rule.selectors.join(', '));

  assert.deepEqual(
    offenders,
    [],
    `these rules centre and cap themselves but never claim the line, so as flex items they collapse to their content: ${offenders.join(' | ')}`,
  );
});

test('the sidebar scrolls at the 720px desktop breakpoint to accommodate analysis', () => {
  const desktop = rules(atRuleBody('@media (min-width: 720px)'));
  const sidebar = desktop.find((r) => r.selectors.includes('.sidebar'));
  assert.ok(sidebar, 'the desktop breakpoint must contain a rule for .sidebar');
  assert.match(sidebar.body, /overflow-y\s*:\s*auto/);
  assert.match(sidebar.body, /min-height\s*:\s*0/);
});

test('analysis evaluation column uses tabular figures and moves text truncates', () => {
  const all = rules();
  const evalRule = all.find((r) => r.selectors.includes('.analysis-eval'));
  assert.ok(evalRule, 'could not find .analysis-eval rule');
  assert.match(evalRule.body, /font-variant-numeric\s*:\s*tabular-nums/);
  assert.match(evalRule.body, /min-width\s*:\s*4\.5ch/);

  const movesRule = all.find((r) => r.selectors.includes('.analysis-moves'));
  assert.ok(movesRule, 'could not find .analysis-moves rule');
  assert.match(movesRule.body, /text-overflow\s*:\s*ellipsis/);
  assert.match(movesRule.body, /white-space\s*:\s*nowrap/);
  assert.match(movesRule.body, /overflow\s*:\s*hidden/);
  assert.match(movesRule.body, /min-width\s*:\s*0/);
});

test('the assess figures align with the analysis column above them', () => {
  const all = rules();
  const valueRule = all.find((r) => r.selectors.includes('.assess-value'));
  assert.ok(valueRule, 'could not find .assess-value rule');
  // The Aligned-Figures Rule. This column is read downward against the analysis rows and the
  // explain row, so it has to sit in the same tabular column at the same width as theirs.
  assert.match(valueRule.body, /font-variant-numeric\s*:\s*tabular-nums/);
  assert.match(valueRule.body, /min-width\s*:\s*4\.5ch/);

  const moveRule = all.find((r) => r.selectors.includes('.assess-move'));
  assert.ok(moveRule, 'could not find .assess-move rule');
  assert.match(moveRule.body, /text-overflow\s*:\s*ellipsis/);
  assert.match(moveRule.body, /min-width\s*:\s*0/);
});

test('the mistake classification is a word, never a colour', () => {
  const verdictRule = rules().find((r) => r.selectors.includes('.assess-verdict'));
  assert.ok(verdictRule, 'could not find .assess-verdict rule');

  // DESIGN.md's Single Accent Rule, and its worked example: achievement tiers are `bronze`/`silver`/
  // `gold` in the muted voice rather than three metal colours, because a system with one accent
  // cannot grow a second, third and fourth, and meaning encoded in hue alone fails colourblind
  // readers. `ok`/`inaccuracy`/`mistake`/`blunder` is a four-value ordinal and takes the same answer:
  // emphasis by weight, severity by the word itself.
  assert.match(verdictRule.body, /font-weight\s*:\s*600/);
  assert.match(verdictRule.body, /color\s*:\s*var\(--fg\)/);

  // Ember specifically. It means the *application* failed — a validation error, a failed action — and
  // a blunder is data the player asked for. Borrowing it here would give one hue two meanings, which
  // is the exact drift that split error colour off from the accent in the first place.
  assert.equal(/--danger|--err|ember|#e5484d|#b42318/i.test(verdictRule.body), false,
    'a blunder must not be painted in the error colour');
});

test('every CSS custom-property reference is defined', () => {
  const stripped = stripCssComments(CSS);
  const referenced = new Set([...stripped.matchAll(/var\(\s*(--[a-zA-Z0-9_-]+)/g)].map((match) => match[1]!));
  const declared = new Set([...stripped.matchAll(/(--[a-zA-Z0-9_-]+)\s*:/g)].map((match) => match[1]!));
  const missing = [...referenced].filter((token) => !declared.has(token));

  assert.deepEqual(
    missing,
    [],
    `these custom properties are referenced with var() but never declared: ${missing.join(', ')}`,
  );
});

test('anchor buttons share the visual, focus and coarse-pointer contract without fake disabled semantics', () => {
  const all = rules();
  const base = all.find((rule) => rule.selectors.includes('button') && rule.selectors.includes('a.button'));
  assert.ok(base, 'expected a shared base rule for `button` and `a.button`');
  assert.match(base.body, /background-color\s*:\s*transparent/);
  assert.match(base.body, /border\s*:\s*1px solid currentColor/);

  const anchor = all.find((rule) => rule.selectors.includes('a.button') && !rule.selectors.includes('button'));
  assert.ok(anchor, 'expected a dedicated `a.button` geometry rule');
  assert.match(anchor.body, /display\s*:\s*inline-flex/);
  assert.match(anchor.body, /align-items\s*:\s*center/);
  assert.match(anchor.body, /justify-content\s*:\s*center/);
  assert.match(anchor.body, /text-decoration\s*:\s*none/);

  const hover = all.find((rule) => rule.selectors.includes('a.button:hover'));
  assert.ok(hover, 'missing hover rule for `a.button`');
  assert.match(hover.body, /background-color\s*:\s*var\(--panel\)/);
  assert.match(hover.body, /box-shadow\s*:\s*var\(--lift\)/);

  const focus = all.find((rule) => rule.selectors.includes('a.button:focus-visible'));
  assert.ok(focus, 'missing focus-visible rule for `a.button`');
  assert.match(focus.body, /outline\s*:\s*3px solid var\(--sel\)/);

  const coarse = rules(atRuleBody('@media (pointer: coarse)'))
    .find((rule) => rule.selectors.includes('a.button'));
  assert.ok(coarse, 'missing coarse-pointer rule for `a.button`');
  assert.match(coarse.body, /min-height\s*:\s*44px/);

  const disabledSelectors = all
    .flatMap((rule) => rule.selectors)
    .filter((selector) => selector.includes(':disabled'));
  assert.equal(
    disabledSelectors.some((selector) => selector.includes('a.button') || selector.includes('a:disabled')),
    false,
    'disabled semantics must remain native-button-only',
  );
});

test('auth metadata links have a visible focus ring and coarse-pointer touch target', () => {
  const focus = rules().find((rule) => rule.selectors.includes('.auth-meta a:focus-visible'));
  assert.ok(focus, 'missing .auth-meta a:focus-visible rule');
  assert.match(focus.body, /outline\s*:\s*3px solid var\(--sel\)/);

  const coarseRules = rules(atRuleBody('@media (pointer: coarse)'));
  const target = coarseRules.find(
    (rule) => rule.selectors.includes('.auth-meta a') && /min-height\s*:\s*44px/.test(rule.body),
  );
  const layout = coarseRules.find(
    (rule) => rule.selectors.includes('.auth-meta a') && /display\s*:\s*inline-flex/.test(rule.body),
  );
  assert.ok(target, 'missing 44px coarse-pointer target for .auth-meta a');
  assert.ok(layout, 'missing coarse-pointer layout rule for .auth-meta a');
  assert.match(layout.body, /align-items\s*:\s*center/);
});

test('seek identity and constraint text are legible, focus-visible, and touch reachable', () => {
  const all = rules();
  const opponent = all.find((rule) => rule.selectors.includes('.seek-opponent'));
  assert.ok(opponent, 'missing seek opponent typography rule');
  assert.match(opponent.body, /color\s*:\s*var\(--fg\)/);

  const details = all.find((rule) => rule.selectors.includes('.seek-details'));
  assert.ok(details, 'missing seek details typography rule');
  assert.match(details.body, /color\s*:\s*var\(--muted\)/);
  assert.match(details.body, /font-size\s*:\s*0\.75rem/);

  const focus = all.find((rule) => rule.selectors.includes('.seek-opponent .row-link:focus-visible'));
  assert.ok(focus, 'missing explicit focus ring for seek opponent links');
  assert.match(focus.body, /outline\s*:\s*3px solid var\(--sel\)/);

  const coarse = rules(atRuleBody('@media (pointer: coarse)')).find(
    (rule) => rule.selectors.includes('.seek-opponent .row-link'),
  );
  assert.ok(coarse, 'missing coarse-pointer geometry for seek opponent links');
  assert.match(coarse.body, /min-height\s*:\s*44px/);
  assert.match(coarse.body, /display\s*:\s*inline-flex/);
  assert.match(coarse.body, /align-items\s*:\s*center/);
});

test('semantic alignment and indentation rules use logical properties', () => {
  const all = rules();
  const physicalHorizontal = /(^|[\s;{])(float|clear)\s*:|(margin|padding|border)-(left|right)\s*:|(^|[\s;])text-align\s*:\s*(left|right)/;
  const targets = [
    '.social-action-destructive',
    '.empty-inline',
    '.game-review-move',
    '.opening-value',
    '.puzzle-value',
    '.explain-value',
    '.coach-value',
    '.assess-value',
    '.quiz-option-btn',
    '.notation-prefix',
    '.notation-variation',
    '.endgame-value',
  ];

  for (const selector of targets) {
    const rule = all.find((candidate) => candidate.selectors.includes(selector));
    assert.ok(rule, `could not find rule for ${selector}`);
    assert.doesNotMatch(rule.body, physicalHorizontal, `${selector} uses a physical horizontal property`);
  }

  assert.match(all.find((rule) => rule.selectors.includes('.social-action-destructive'))!.body, /margin-inline-start\s*:\s*auto/);
  assert.match(all.find((rule) => rule.selectors.includes('.notation-prefix'))!.body, /margin-inline-end\s*:\s*2px/);

  const variation = all.find((rule) => rule.selectors.includes('.notation-variation'))!;
  assert.match(variation.body, /margin-inline-start\s*:\s*12px/);
  assert.match(variation.body, /padding-inline-start\s*:\s*8px/);
  assert.match(variation.body, /border-inline-start\s*:\s*2px solid var\(--panel-strong\)/);

  for (const selector of ['.empty-inline', '.game-review-move', '.quiz-option-btn']) {
    assert.match(all.find((rule) => rule.selectors.includes(selector))!.body, /text-align\s*:\s*start/);
  }
  for (const selector of ['.opening-value', '.puzzle-value', '.explain-value', '.coach-value', '.assess-value', '.endgame-value']) {
    assert.match(all.find((rule) => rule.selectors.includes(selector))!.body, /text-align\s*:\s*end/);
  }
});
