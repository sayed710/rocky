/**
 * Create-a-game panel — the lobby's focused seek builder.
 *
 * The collapsed trigger opens one short form for time, mode, and color, with
 * variant and optional opponent-rating bounds behind a "More options"
 * disclosure — the hierarchy the confirmed design brief specifies.
 * The component owns only DOM and form state; the lobby wiring remains
 * responsible for the network request.
 */
import {
  OFFERED_VARIANTS,
  SEEK_COLORS,
  type SeekColor,
  type TimeControl,
  type Variant,
} from '../api/models.js';
import type { I18nManager } from '../i18n/manager.js';
import type { KeyValueStorage } from '../net/session.js';
import {
  CREATE_GAME_PRESETS,
  CUSTOM_LIMITS,
  CUSTOM_PRESET_ID,
  DEFAULT_PRESET_ID,
  UNLIMITED_TIME_CONTROL,
  UNLIMITED_TIME_ID,
  estimateSpeed,
  presetToTimeControl,
  validateCustomTime,
  type CustomTimeErrorCode,
} from './time-presets.js';
import {
  DEFAULT_CREATE_GAME_COLOR,
  DEFAULT_CREATE_GAME_VARIANT,
  PREFS_STORAGE_KEY,
  isOfferedVariant,
  isSeekColor,
  parseCreateGamePrefs,
  parseRatingBound,
  serializeCreateGamePrefs,
  type CreateGamePrefs,
  type SeekMode,
} from './create-game-prefs.js';
import { el } from './dom.js';
import { VARIANT_LABELS, getVariantLabel } from './variant-labels.js';

const CREATE_GAME_COLORS: readonly SeekColor[] = [
  DEFAULT_CREATE_GAME_COLOR,
  ...SEEK_COLORS.filter((color) => color !== DEFAULT_CREATE_GAME_COLOR),
];

/** Id of the disclosure region, referenced by the toggle's `aria-controls`. */
const ADVANCED_REGION_ID = 'cg-more-options';

/** A rating range as the panel would submit it, or the fact that it is unusable. */
export type RatingSummary =
  | { readonly ok: true; readonly minRating: number | null; readonly maxRating: number | null }
  | { readonly ok: false };

/**
 * Describe the advanced choices for the collapsed disclosure.
 *
 * An active variant or rating bound must never be invisible, so this is what the
 * closed row says instead. It is worded rather than glyphed — a screen reader
 * gets the same sentence the eye does — and a range the panel would reject says
 * so, rather than reading as a settled choice.
 */
export function formatMoreOptionsSummary(
  variant: Variant,
  rating: RatingSummary,
  i18n: I18nManager,
): string {
  const label = getVariantLabel(variant, i18n);
  if (!rating.ok) {
    return i18n.t('lobby.summary.ratingAttention', { variant: label });
  }
  const { minRating, maxRating } = rating;
  if (minRating !== null && maxRating !== null) {
    if (minRating === maxRating) {
      return i18n.t('lobby.summary.ratingExact', { variant: label, rating: String(minRating) });
    }
    return i18n.t('lobby.summary.ratingRange', {
      variant: label,
      min: String(minRating),
      max: String(maxRating),
    });
  }
  if (minRating !== null) {
    return i18n.t('lobby.summary.ratingMin', { variant: label, min: String(minRating) });
  }
  if (maxRating !== null) {
    return i18n.t('lobby.summary.ratingMax', { variant: label, max: String(maxRating) });
  }
  return i18n.t('lobby.summary.ratingAny', { variant: label });
}

/** The validated settings sent through the existing seek-creation path. */
export interface CreateGameParams {
  readonly variant: Variant;
  readonly timeControl: TimeControl;
  readonly rated: boolean;
  readonly color: SeekColor;
  readonly minRating: number | null;
  readonly maxRating: number | null;
}

export interface CreateGamePanelCallbacks {
  /** Post the seek. Resolve true when created, false when the form should stay open. */
  onSubmit: (params: CreateGameParams) => Promise<boolean>;
  /** Surface an action error, or clear it with null. */
  onError: (message: string | null) => void;
}

export interface CreateGamePanelOptions {
  readonly doc: Document;
  readonly mount: HTMLElement;
  readonly callbacks: CreateGamePanelCallbacks;
  readonly initialAuthenticated?: boolean | undefined;
  /** Persists the last successful settings. */
  readonly storage?: KeyValueStorage | undefined;
  readonly i18n: I18nManager;
}

export class CreateGamePanel {
  private readonly doc: Document;
  private readonly callbacks: CreateGamePanelCallbacks;
  private readonly trigger: HTMLButtonElement;
  private readonly form: HTMLFormElement;
  private readonly submitBtn: HTMLButtonElement;
  private readonly cancelBtn: HTMLButtonElement;
  private readonly customFields: HTMLDivElement;
  private readonly customMinutes: HTMLInputElement;
  private readonly customIncrement: HTMLInputElement;
  private readonly customError: HTMLParagraphElement;
  private readonly minRating: HTMLInputElement;
  private readonly maxRating: HTMLInputElement;
  private readonly ratingError: HTMLParagraphElement;
  private readonly timeSummary: HTMLParagraphElement;
  private readonly moreToggle: HTMLButtonElement;
  private readonly moreSummary: HTMLSpanElement;
  private readonly advancedRegion: HTMLDivElement;
  private readonly storage: KeyValueStorage | undefined;
  private readonly i18n: I18nManager;
  private readonly unsubscribeLocale: () => void;
  private timeLegend!: HTMLLegendElement;
  private customMinutesLabel!: HTMLSpanElement;
  private customIncrementLabel!: HTMLSpanElement;
  private modeLegend!: HTMLLegendElement;
  private modeHintEl!: HTMLParagraphElement;
  private variantLegend!: HTMLLegendElement;
  private colorLegend!: HTMLLegendElement;
  private ratingLegend!: HTMLLegendElement;
  private ratingMinSpan!: HTMLSpanElement;
  private ratingMaxSpan!: HTMLSpanElement;
  private ratingHintEl!: HTMLParagraphElement;
  private moreLabelEl!: HTMLSpanElement;

  private expanded = false;
  private pending = false;
  /** Disclosure openness is presentation only — never persisted, never submitted. */
  private advancedOpen = false;

  constructor(opts: CreateGamePanelOptions) {
    this.doc = opts.doc;
    this.callbacks = opts.callbacks;
    this.storage = opts.storage;
    this.i18n = opts.i18n;
    const prefs = this.readPrefs();
    this.trigger = this.createTrigger();
    this.submitBtn = el(this.doc, 'button', { type: 'submit', class: 'cg-submit' });
    this.submitBtn.textContent = this.i18n.t('lobby.createSeekSubmit');
    this.cancelBtn = el(this.doc, 'button', { type: 'button', class: 'cg-cancel' });
    this.cancelBtn.textContent = this.i18n.t('common.cancel');
    this.customMinutes = this.numberInput(
      'cg-minutes',
      {
        min: CUSTOM_LIMITS.minMinutes,
        max: CUSTOM_LIMITS.maxMinutes,
        step: CUSTOM_LIMITS.minuteStep,
      },
      'decimal',
    );
    this.customIncrement = this.numberInput(
      'cg-increment',
      {
        min: CUSTOM_LIMITS.minIncrement,
        max: CUSTOM_LIMITS.maxIncrement,
        step: 1,
      },
      'numeric',
    );
    this.customError = el(this.doc, 'p', {
      class: 'cg-field-error',
      id: 'cg-custom-error',
      role: 'alert',
      hidden: '',
    });
    this.minRating = this.ratingInput('cg-min-rating');
    this.maxRating = this.ratingInput('cg-max-rating');
    this.ratingError = el(this.doc, 'p', {
      class: 'cg-field-error',
      id: 'cg-rating-error',
      role: 'alert',
      hidden: '',
    });
    this.customFields = this.createCustomFields(
      prefs?.time === CUSTOM_PRESET_ID ? prefs.minutes : 5,
      prefs?.time === CUSTOM_PRESET_ID ? prefs.increment : 0,
    );
    this.timeSummary = el(this.doc, 'p', { class: 'cg-time-summary', 'aria-live': 'polite' });
    this.form = el(this.doc, 'form', {
      id: 'create-game-form',
      class: 'cg-form',
      'aria-label': this.i18n.t('lobby.createGame'),
      novalidate: '',
      hidden: '',
    });
    this.moreSummary = el(this.doc, 'span', { class: 'cg-more-summary', dir: 'ltr' });
    this.moreLabelEl = el(this.doc, 'span', { class: 'cg-more-label' }, this.i18n.t('lobby.moreOptions'));
    this.moreToggle = el(this.doc, 'button', {
      type: 'button',
      class: 'cg-more-toggle',
      'aria-expanded': 'false',
      'aria-controls': ADVANCED_REGION_ID,
    });
    this.moreToggle.append(
      this.moreLabelEl,
      this.moreSummary,
    );
    this.advancedRegion = el(
      this.doc,
      'div',
      { id: ADVANCED_REGION_ID, class: 'cg-more', hidden: '' },
      this.createVariantField(prefs?.variant ?? DEFAULT_CREATE_GAME_VARIANT),
      this.createRatingField(prefs?.minRating ?? null, prefs?.maxRating ?? null),
    );
    this.form.append(
      this.createTimeField(prefs?.time ?? DEFAULT_PRESET_ID),
      this.createModeField(prefs?.mode ?? 'casual'),
      this.createColorField(prefs?.color ?? DEFAULT_CREATE_GAME_COLOR),
      this.moreToggle,
      this.advancedRegion,
      el(this.doc, 'div', { class: 'cg-actions' }, this.submitBtn, this.cancelBtn),
    );
    this.bindEvents();
    this.syncTimeSelection(false);
    // Derived, never restored: an advanced choice that survived in prefs opens
    // the section rather than sitting behind a closed row.
    this.setAdvancedOpen(this.hasAdvancedState());
    opts.mount.replaceChildren(this.trigger, this.form);
    this.setAuthenticated(opts.initialAuthenticated ?? false);

    this.unsubscribeLocale = this.i18n.onLocaleChange(() => {
      this.trigger.textContent = this.i18n.t('lobby.createGame');
      this.form.setAttribute('aria-label', this.i18n.t('lobby.createGame'));
      this.submitBtn.textContent = this.pending
        ? this.i18n.t('lobby.creating')
        : this.i18n.t('lobby.createSeekSubmit');
      this.cancelBtn.textContent = this.i18n.t('common.cancel');
      if (this.timeLegend) this.timeLegend.textContent = this.i18n.t('lobby.time');
      if (this.customMinutesLabel) this.customMinutesLabel.textContent = this.i18n.t('lobby.minutes');
      if (this.customIncrementLabel) this.customIncrementLabel.textContent = this.i18n.t('lobby.incrementSeconds');
      if (this.modeLegend) this.modeLegend.textContent = this.i18n.t('lobby.mode');
      if (this.modeHintEl) this.modeHintEl.textContent = this.i18n.t('lobby.modeHint');
      if (this.variantLegend) this.variantLegend.textContent = this.i18n.t('lobby.variant');
      if (this.colorLegend) this.colorLegend.textContent = this.i18n.t('lobby.color');
      if (this.ratingLegend) this.ratingLegend.textContent = this.i18n.t('lobby.ratingOpponent');
      if (this.ratingMinSpan) this.ratingMinSpan.textContent = this.i18n.t('lobby.ratingMinLabel');
      if (this.ratingMaxSpan) this.ratingMaxSpan.textContent = this.i18n.t('lobby.ratingMaxLabel');
      if (this.ratingHintEl) this.ratingHintEl.textContent = this.i18n.t('lobby.ratingHint');
      if (this.moreLabelEl) this.moreLabelEl.textContent = this.i18n.t('lobby.moreOptions');
      this.syncTimeSelection(false);
      this.syncAdvancedSummary();
      this.refreshRatingError();
      this.refreshCustomError();
    });
  }

  dispose(): void {
    this.unsubscribeLocale();
  }

  /** Build the collapsed entry point that owns the form disclosure state. */
  private createTrigger(): HTMLButtonElement {
    const trigger = el(this.doc, 'button', {
      id: 'create-seek',
      type: 'button',
      class: 'cg-trigger',
      'aria-expanded': 'false',
      'aria-controls': 'create-game-form',
    });
    trigger.textContent = this.i18n.t('lobby.createGame');
    return trigger;
  }

  /** Build the time-control radio group with one guaranteed initial choice. */
  private createTimeField(initialTimeId: string): HTMLFieldSetElement {
    const presets = el(this.doc, 'div', { class: 'cg-presets' });
    for (const preset of CREATE_GAME_PRESETS) {
      const speed = estimateSpeed(presetToTimeControl(preset.minutes, preset.increment));
      presets.append(this.radio('cg-time', preset.id, preset.id, preset.id === initialTimeId, speed));
    }
    presets.append(
      this.radio(
        'cg-time',
        UNLIMITED_TIME_ID,
        this.i18n.t('lobby.timeUnlimited'),
        initialTimeId === UNLIMITED_TIME_ID,
        estimateSpeed(UNLIMITED_TIME_CONTROL),
      ),
      this.radio('cg-time', CUSTOM_PRESET_ID, this.i18n.t('lobby.timeCustom'), initialTimeId === CUSTOM_PRESET_ID),
    );
    this.timeLegend = el(this.doc, 'legend', {}, this.i18n.t('lobby.time'));
    return el(
      this.doc,
      'fieldset',
      { class: 'cg-field' },
      this.timeLegend,
      presets,
      el(this.doc, 'div', { class: 'cg-time-detail' }, this.timeSummary, this.customFields),
    );
  }

  /** Build bounded custom time inputs without changing the existing API contract. */
  private createCustomFields(minutes: number, increment: number): HTMLDivElement {
    this.customMinutes.value = String(minutes);
    this.customIncrement.value = String(increment);
    this.customMinutes.setAttribute('aria-describedby', 'cg-custom-error');
    this.customIncrement.setAttribute('aria-describedby', 'cg-custom-error');
    this.customMinutesLabel = el(this.doc, 'span', {}, this.i18n.t('lobby.minutes'));
    this.customIncrementLabel = el(this.doc, 'span', {}, this.i18n.t('lobby.incrementSeconds'));
    return el(
      this.doc,
      'div',
      { class: 'cg-custom', hidden: '' },
      el(
        this.doc,
        'label',
        { class: 'cg-num' },
        this.customMinutesLabel,
        this.customMinutes,
      ),
      el(
        this.doc,
        'label',
        { class: 'cg-num' },
        this.customIncrementLabel,
        this.customIncrement,
      ),
      this.customError,
    );
  }

  /** Create one constrained number input whose browser hints mirror validation. */
  private numberInput(
    id: string,
    limits: { readonly min: number; readonly max: number; readonly step: number },
    inputMode: 'decimal' | 'numeric',
  ): HTMLInputElement {
    return el(this.doc, 'input', {
      id,
      type: 'number',
      min: String(limits.min),
      max: String(limits.max),
      step: String(limits.step),
      inputmode: inputMode,
      autocomplete: 'off',
    });
  }

  /** Create a text input so browser number coercion cannot admit exponent notation. */
  private ratingInput(id: string): HTMLInputElement {
    return el(this.doc, 'input', {
      id,
      type: 'text',
      inputmode: 'numeric',
      autocomplete: 'off',
      dir: 'ltr',
      'aria-describedby': 'cg-rating-hint cg-rating-error',
    });
  }

  /** Build the mutually exclusive Casual/Rated radio group and its explanation. */
  private createModeField(initialMode: SeekMode): HTMLFieldSetElement {
    this.modeHintEl = el(
      this.doc,
      'p',
      { class: 'cg-hint', id: 'cg-mode-hint' },
      this.i18n.t('lobby.modeHint'),
    );
    const modes = el(
      this.doc,
      'div',
      { class: 'cg-segmented' },
      this.radio('cg-mode', 'casual', this.i18n.t('lobby.mode.casual'), initialMode === 'casual'),
      this.radio('cg-mode', 'rated', this.i18n.t('lobby.mode.rated'), initialMode === 'rated'),
    );
    this.modeLegend = el(this.doc, 'legend', {}, this.i18n.t('lobby.mode'));
    const modeField = el(
      this.doc,
      'fieldset',
      { class: 'cg-field' },
      this.modeLegend,
      modes,
      this.modeHintEl,
    );
    for (const radio of modes.querySelectorAll<HTMLInputElement>('input[name="cg-mode"]')) {
      radio.setAttribute('aria-describedby', 'cg-mode-hint');
    }
    return modeField;
  }

  /** Build the canonical player-facing variant choices. */
  private createVariantField(initialVariant: Variant): HTMLFieldSetElement {
    const variants = el(this.doc, 'div', { class: 'cg-variants' });
    for (const variant of OFFERED_VARIANTS) {
      variants.append(
        this.radio('cg-variant', variant, getVariantLabel(variant, this.i18n), variant === initialVariant),
      );
    }
    this.variantLegend = el(this.doc, 'legend', {}, this.i18n.t('lobby.variant'));
    return el(
      this.doc,
      'fieldset',
      { class: 'cg-field' },
      this.variantLegend,
      variants,
    );
  }

  private getColorLabel(color: SeekColor): string {
    switch (color) {
      case 'white': return this.i18n.t('lobby.color.white');
      case 'black': return this.i18n.t('lobby.color.black');
      case 'random': return this.i18n.t('lobby.color.random');
    }
  }

  /** Build the color preference choices in their player-facing order. */
  private createColorField(initialColor: SeekColor): HTMLFieldSetElement {
    const colors = el(this.doc, 'div', { class: 'cg-colors' });
    for (const color of CREATE_GAME_COLORS) {
      colors.append(this.radio('cg-color', color, this.getColorLabel(color), color === initialColor));
    }
    this.colorLegend = el(this.doc, 'legend', {}, this.i18n.t('lobby.color'));
    return el(
      this.doc,
      'fieldset',
      { class: 'cg-field' },
      this.colorLegend,
      colors,
    );
  }

  /** Build optional exact opponent-rating bounds; blank is the unrestricted state. */
  private createRatingField(
    initialMinimum: number | null,
    initialMaximum: number | null,
  ): HTMLFieldSetElement {
    this.minRating.value = initialMinimum === null ? '' : String(initialMinimum);
    this.maxRating.value = initialMaximum === null ? '' : String(initialMaximum);
    this.ratingLegend = el(this.doc, 'legend', {}, this.i18n.t('lobby.ratingOpponent'));
    this.ratingMinSpan = el(this.doc, 'span', {}, this.i18n.t('lobby.ratingMinLabel'));
    this.ratingMaxSpan = el(this.doc, 'span', {}, this.i18n.t('lobby.ratingMaxLabel'));
    this.ratingHintEl = el(
      this.doc,
      'p',
      { class: 'cg-hint', id: 'cg-rating-hint' },
      this.i18n.t('lobby.ratingHint'),
    );
    return el(
      this.doc,
      'fieldset',
      { class: 'cg-field' },
      this.ratingLegend,
      el(
        this.doc,
        'div',
        { class: 'cg-rating' },
        el(
          this.doc,
          'label',
          { class: 'cg-num' },
          this.ratingMinSpan,
          this.minRating,
        ),
        el(
          this.doc,
          'label',
          { class: 'cg-num' },
          this.ratingMaxSpan,
          this.maxRating,
        ),
        this.ratingHintEl,
        this.ratingError,
      ),
    );
  }

  /** Bind disclosure, cancellation, submission, and Escape behavior once. */
  private bindEvents(): void {
    this.trigger.addEventListener('click', () => this.setExpanded(true));
    this.cancelBtn.addEventListener('click', () => this.setExpanded(false));
    for (const radio of this.form.querySelectorAll<HTMLInputElement>('input[name="cg-time"]')) {
      radio.addEventListener('change', () => this.syncTimeSelection(true));
    }
    this.customMinutes.addEventListener('input', () => this.clearCustomError(this.customMinutes));
    this.customIncrement.addEventListener('input', () => this.clearCustomError(this.customIncrement));
    this.minRating.addEventListener('input', () => this.refreshRatingError());
    this.maxRating.addEventListener('input', () => this.refreshRatingError());
    this.moreToggle.addEventListener('click', () => {
      // Closing on a rating the panel would reject retires only the inline
      // message; the values stay, the summary still says so, and submitting
      // re-opens and re-reports. Clearing it outright would hide a real problem.
      if (this.advancedOpen) this.clearRatingError();
      this.setAdvancedOpen(!this.advancedOpen);
      // Claim focus rather than inspect it. Browsers disagree about what a click
      // does to focus — Chromium focuses the button, Safari and Firefox on macOS
      // do not and blur to the document instead — so reading activeElement to
      // decide would be wrong on the engines that need this most. Collapsing
      // hides whatever the player was editing; the control they just operated is
      // where focus belongs either way, and re-focusing it is a no-op elsewhere.
      this.moreToggle.focus();
    });
    this.form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.submit();
    });
    this.form.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || this.pending) return;
      event.preventDefault();
      this.setExpanded(false);
    });
  }

  /** Create a native radio wrapped by the visual chip or segmented-control label. */
  private radio(
    name: 'cg-time' | 'cg-variant' | 'cg-mode' | 'cg-color',
    value: string,
    label: string,
    checked: boolean,
    secondary?: string,
  ): HTMLLabelElement {
    const isChip = name === 'cg-time' || name === 'cg-variant';
    const className = isChip ? 'cg-chip' : 'cg-seg';
    const labelClass = name === 'cg-time' ? 'cg-chip-label' : 'cg-option-label';
    const input = el(this.doc, 'input', { type: 'radio', name, value });
    if (checked) input.checked = true;
    return el(
      this.doc,
      'label',
      { class: className },
      input,
      el(
        this.doc,
        'span',
        {
          class: className === 'cg-chip' ? labelClass : 'cg-seg-label',
          ...(name === 'cg-time' ? { dir: 'ltr' } : {}),
        },
        label,
      ),
      ...(secondary ? [el(this.doc, 'span', { class: 'cg-chip-speed' }, secondary)] : []),
    );
  }

  /** Read the selected value from a named native radio group. */
  private readChecked(name: string): string | null {
    return this.form.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`)?.value ?? null;
  }

  /** Convert validated selections into the exact existing seek request contract. */
  private gather(): { readonly params: CreateGameParams; readonly prefs: CreateGamePrefs } | null {
    const selected = this.readChecked('cg-time');
    const mode = this.readChecked('cg-mode') === 'rated' ? 'rated' : 'casual';
    const variant = this.readChecked('cg-variant');
    const color = this.readChecked('cg-color');
    if (!isOfferedVariant(variant) || !isSeekColor(color)) return null;
    const ratingValidation = this.validateRatingRange();
    if (ratingValidation.ok) {
      this.clearRatingError();
    } else {
      // Render both independent channels before focusing the first invalid field once.
      this.setRatingError(ratingValidation.message, ratingValidation.input);
    }
    if (selected === CUSTOM_PRESET_ID) {
      const minutes = this.customMinutes.value.trim() === '' ? Number.NaN : Number(this.customMinutes.value);
      const increment =
        this.customIncrement.value.trim() === '' ? Number.NaN : Number(this.customIncrement.value);
      const validation = validateCustomTime(minutes, increment);
      if (!validation.ok) {
        this.showCustomError(validation.code, validation.field);
        return null;
      }
      this.clearCustomError();
      if (!ratingValidation.ok) {
        ratingValidation.input.focus();
        return null;
      }
      const ratings = ratingValidation.value;
      return {
        params: {
          variant,
          timeControl: validation.timeControl,
          rated: mode === 'rated',
          color,
          ...ratings,
        },
        prefs: {
          time: CUSTOM_PRESET_ID,
          minutes,
          increment,
          mode,
          variant,
          color,
          ...ratings,
        },
      };
    }

    if (selected === UNLIMITED_TIME_ID) {
      // The custom fields are deliberately not read: they belong to a choice that
      // is not selected, so whatever they hold — valid or not — cannot reach the
      // request or block it.
      if (!ratingValidation.ok) {
        ratingValidation.input.focus();
        return null;
      }
      const ratings = ratingValidation.value;
      return {
        params: {
          variant,
          timeControl: UNLIMITED_TIME_CONTROL,
          rated: mode === 'rated',
          color,
          ...ratings,
        },
        prefs: { time: UNLIMITED_TIME_ID, mode, variant, color, ...ratings },
      };
    }

    const preset = CREATE_GAME_PRESETS.find((candidate) => candidate.id === selected);
    if (!preset) return null;
    if (!ratingValidation.ok) {
      ratingValidation.input.focus();
      return null;
    }
    const ratings = ratingValidation.value;

    return {
      params: {
        variant,
        timeControl: presetToTimeControl(preset.minutes, preset.increment),
        rated: mode === 'rated',
        color,
        ...ratings,
      },
      prefs: {
        time: preset.id,
        mode,
        variant,
        color,
        ...ratings,
      },
    };
  }

  /** Validate the complete range without changing focus or rendered feedback. */
  private validateRatingRange():
    | {
        readonly ok: true;
        readonly value: { readonly minRating: number | null; readonly maxRating: number | null };
      }
    | {
        readonly ok: false;
        readonly code: 'rating_bound' | 'rating_order';
        readonly message: string;
        readonly input: HTMLInputElement;
      } {
    const minimum = parseRatingBound(this.minRating.value);
    const maximum = parseRatingBound(this.maxRating.value);
    if (!minimum.ok) {
      return {
        ok: false,
        code: 'rating_bound',
        message: this.i18n.t('lobby.createGame.error.ratingBound'),
        input: this.minRating,
      };
    }
    if (!maximum.ok) {
      return {
        ok: false,
        code: 'rating_bound',
        message: this.i18n.t('lobby.createGame.error.ratingBound'),
        input: this.maxRating,
      };
    }
    if (minimum.value !== null && maximum.value !== null && minimum.value > maximum.value) {
      return {
        ok: false,
        code: 'rating_order',
        message: this.i18n.t('lobby.createGame.error.ratingOrder'),
        input: this.minRating,
      };
    }
    return { ok: true, value: { minRating: minimum.value, maxRating: maximum.value } };
  }

  /** Read only preferences that still belong to the approved choice sets. */
  private readPrefs(): CreateGamePrefs | null {
    if (!this.storage) return null;
    try {
      return parseCreateGamePrefs(this.storage.getItem(PREFS_STORAGE_KEY));
    } catch {
      return null;
    }
  }

  /** Persist successful choices without making storage a creation dependency. */
  private savePrefs(prefs: CreateGamePrefs): void {
    if (!this.storage) return;
    try {
      this.storage.setItem(PREFS_STORAGE_KEY, serializeCreateGamePrefs(prefs));
    } catch {
      // Storage can be unavailable in private browsing; seek creation still succeeds.
    }
  }

  /** Run one creation attempt, preserving selections and retryability on failure. */
  private async submit(): Promise<void> {
    if (this.pending) return;
    this.callbacks.onError(null);
    const submission = this.gather();
    if (!submission) return;
    this.setPending(true);
    try {
      const created = await this.callbacks.onSubmit(submission.params);
      if (created) {
        this.savePrefs(submission.prefs);
        this.setExpanded(false);
      }
    } catch (error) {
      this.callbacks.onError(error instanceof Error ? error.message : String(error));
    } finally {
      this.setPending(false);
    }
  }

  /** Keep disclosure state, focus, and error clearing synchronized. */
  private setExpanded(expanded: boolean): void {
    this.expanded = expanded;
    this.trigger.setAttribute('aria-expanded', String(expanded));
    this.trigger.hidden = expanded;
    this.form.hidden = !expanded;
    if (expanded) {
      this.setAdvancedOpen(this.hasAdvancedState());
      this.form.querySelector<HTMLInputElement>('input[name="cg-time"]:checked')?.focus();
    } else {
      this.callbacks.onError(null);
      if (!this.trigger.disabled) this.trigger.focus();
    }
  }

  /** True when a choice inside the disclosure differs from the quiet default. */
  private hasAdvancedState(): boolean {
    const variant = this.readChecked('cg-variant');
    return (
      variant !== DEFAULT_CREATE_GAME_VARIANT ||
      this.minRating.value.trim() !== '' ||
      this.maxRating.value.trim() !== ''
    );
  }

  /**
   * Show or hide the advanced region.
   *
   * `hidden` rather than detaching it: the controls keep their values and stay
   * readable by {@link gather}, so what the panel submits never depends on what
   * the panel is showing.
   */
  private setAdvancedOpen(open: boolean): void {
    this.advancedOpen = open;
    this.moreToggle.setAttribute('aria-expanded', String(open));
    this.advancedRegion.hidden = !open;
    this.syncAdvancedSummary();
  }

  /** Keep the collapsed row describing the values that would actually be sent. */
  private syncAdvancedSummary(): void {
    this.moreSummary.hidden = this.advancedOpen;
    if (this.advancedOpen) {
      this.moreSummary.textContent = '';
      return;
    }
    const variant = this.readChecked('cg-variant');
    const rating = this.validateRatingRange();
    this.moreSummary.textContent = formatMoreOptionsSummary(
      isOfferedVariant(variant) ? variant : DEFAULT_CREATE_GAME_VARIANT,
      rating.ok ? { ok: true, ...rating.value } : { ok: false },
      this.i18n,
    );
  }

  /** Gate the entire flow and collapse it immediately when authentication is lost. */
  setAuthenticated(authenticated: boolean): void {
    this.trigger.disabled = !authenticated;
    this.trigger.title = authenticated ? '' : this.i18n.t('lobby.signInToCreate');
    if (!authenticated && this.expanded) this.setExpanded(false);
  }

  /** Reflect the controller's in-flight state while preventing duplicate submission. */
  setPending(pending: boolean): void {
    this.pending = pending;
    this.form.setAttribute('aria-busy', String(pending));
    this.submitBtn.disabled = pending;
    this.cancelBtn.disabled = pending;
    this.minRating.disabled = pending;
    this.maxRating.disabled = pending;
    this.moreToggle.disabled = pending;
    for (const name of ['cg-time', 'cg-variant', 'cg-mode', 'cg-color']) {
      for (const radio of this.form.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`)) {
        radio.disabled = pending;
      }
    }
    this.syncTimeSelection(false);
    this.submitBtn.textContent = pending
      ? this.i18n.t('lobby.creating')
      : this.i18n.t('lobby.createSeekSubmit');
  }

  /** Synchronize custom-field visibility and a stable summary region. */
  private syncTimeSelection(focusCustom: boolean): void {
    const selected = this.readChecked('cg-time');
    const isCustom = selected === CUSTOM_PRESET_ID;
    this.customFields.hidden = !isCustom;
    this.timeSummary.hidden = isCustom;
    this.customMinutes.disabled = this.pending || !isCustom;
    this.customIncrement.disabled = this.pending || !isCustom;
    if (isCustom) {
      this.timeSummary.textContent = '';
      if (focusCustom && !this.pending) this.customMinutes.focus();
      return;
    }
    this.clearCustomError();
    if (selected === UNLIMITED_TIME_ID) {
      this.timeSummary.textContent = this.i18n.t('lobby.timeUnlimitedSummary', {
        speed: estimateSpeed(UNLIMITED_TIME_CONTROL),
      });
      return;
    }
    const preset = CREATE_GAME_PRESETS.find((candidate) => candidate.id === selected);
    if (!preset) return;
    const speed = estimateSpeed(presetToTimeControl(preset.minutes, preset.increment));
    const minutes = preset.minutes === 1
      ? this.i18n.t('lobby.oneMinute')
      : this.i18n.t('lobby.manyMinutes', { count: String(preset.minutes) });
    const increment = preset.increment === 0
      ? this.i18n.t('lobby.noIncrement')
      : this.i18n.t('lobby.secondIncrement', { count: String(preset.increment) });
    this.timeSummary.textContent = this.i18n.t('lobby.timePresetSummary', { speed, minutes, increment });
  }

  /** Surface one custom validation error at the field that needs correction. */
  private showCustomError(code: CustomTimeErrorCode, field: 'minutes' | 'increment'): void {
    const message = code === 'minutes_range'
      ? this.i18n.t('lobby.createGame.error.customMinutes')
      : this.i18n.t('lobby.createGame.error.customIncrement');
    this.customError.textContent = message;
    this.customError.hidden = false;
    this.customMinutes.removeAttribute('aria-invalid');
    this.customIncrement.removeAttribute('aria-invalid');
    const input = field === 'minutes' ? this.customMinutes : this.customIncrement;
    input.setAttribute('aria-invalid', 'true');
    input.focus();
  }

  /** Refresh an existing custom time error without moving focus or clearing values. */
  private refreshCustomError(): void {
    if (this.customError.hidden) return;
    const minutes = this.customMinutes.value.trim() === '' ? Number.NaN : Number(this.customMinutes.value);
    const increment =
      this.customIncrement.value.trim() === '' ? Number.NaN : Number(this.customIncrement.value);
    const validation = validateCustomTime(minutes, increment);
    if (!validation.ok) {
      const message = validation.code === 'minutes_range'
        ? this.i18n.t('lobby.createGame.error.customMinutes')
        : this.i18n.t('lobby.createGame.error.customIncrement');
      this.customError.textContent = message;
      return;
    }
    this.clearCustomError();
  }

  /** Clear custom validation state without affecting the lobby-level error region. */
  private clearCustomError(input?: HTMLInputElement): void {
    if (input && !input.hasAttribute('aria-invalid')) return;
    this.customError.textContent = '';
    this.customError.hidden = true;
    if (input) {
      input.removeAttribute('aria-invalid');
    } else {
      this.customMinutes.removeAttribute('aria-invalid');
      this.customIncrement.removeAttribute('aria-invalid');
    }
  }

  /** Refresh an existing rating error without moving focus while the player types. */
  private refreshRatingError(): void {
    if (this.ratingError.hidden) return;
    const validation = this.validateRatingRange();
    if (!validation.ok) {
      this.setRatingError(validation.message, validation.input);
      return;
    }
    this.clearRatingError();
  }

  /** Render shared rating feedback and mark only its current owning field. */
  private setRatingError(message: string, input: HTMLInputElement): void {
    // Reveal before anyone focuses `input`: it lives inside the disclosure, and
    // focusing a hidden field would leave the player staring at a form that
    // refuses to submit for no visible reason.
    if (!this.advancedOpen) this.setAdvancedOpen(true);
    this.ratingError.textContent = message;
    this.ratingError.hidden = false;
    this.minRating.removeAttribute('aria-invalid');
    this.maxRating.removeAttribute('aria-invalid');
    input.setAttribute('aria-invalid', 'true');
  }

  /** Clear only the rating validation channel, preserving custom-time feedback. */
  private clearRatingError(): void {
    this.ratingError.textContent = '';
    this.ratingError.hidden = true;
    this.minRating.removeAttribute('aria-invalid');
    this.maxRating.removeAttribute('aria-invalid');
  }

}
