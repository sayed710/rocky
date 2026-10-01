/**
 * Play vs Computer dialog — the lobby's bot game launcher.
 *
 * A trigger button "Play vs Computer" opens a native `<dialog>` modal with options
 * for difficulty (Novice, Club, Master), side preference (White, Random, Black), and
 * time control presets.
 *
 * It uses native `<dialog>` for built-in focus trapping and Escape handling. The
 * component owns its DOM and form state, delegating submission to `onSubmit`.
 */
import type { BotLevel, SeekColor, TimeControl } from '../api/models.js';
import type { I18nManager } from '../i18n/manager.js';
import { el } from './dom.js';
import { BOT_LEVELS, DEFAULT_BOT_LEVEL, parseBotLevel } from './bot-levels.js';
import { TIME_PRESETS, DEFAULT_PRESET_ID, presetToTimeControl, estimateSpeed } from './time-presets.js';
import { getSpeedLabel } from './variant-labels.js';

export interface CreateBotGameParams {
  readonly level: BotLevel;
  readonly color: SeekColor;
  readonly timeControl: TimeControl;
}

export interface PlayBotDialogCallbacks {
  /**
   * Create the game. Resolve the new game id on success, or null on failure after calling
   * {@link PlayBotDialog.setError} — the dialog is modal, so its own error region is the only one
   * the player can see while it is open.
   */
  onSubmit: (params: CreateBotGameParams) => Promise<string | null>;
}

export interface PlayBotDialogOptions {
  readonly doc: Document;
  readonly mount: HTMLElement;
  readonly callbacks: PlayBotDialogCallbacks;
  readonly initialAuthenticated?: boolean;
  readonly i18n: I18nManager;
}

interface ColorOption {
  readonly value: SeekColor;
  readonly labelKey: 'bot.color.white' | 'bot.color.random' | 'bot.color.black';
  readonly glyph: string;
}

const COLOR_OPTIONS: readonly ColorOption[] = [
  { value: 'white', labelKey: 'bot.color.white', glyph: '♔' },
  { value: 'random', labelKey: 'bot.color.random', glyph: '½' },
  { value: 'black', labelKey: 'bot.color.black', glyph: '♚' },
];

export class PlayBotDialog {
  private readonly doc: Document;
  private readonly callbacks: PlayBotDialogCallbacks;
  private readonly i18n: I18nManager;
  private readonly unsubscribeLocale: () => void;

  private readonly trigger: HTMLButtonElement;
  private readonly dialog: HTMLDialogElement;
  private readonly form: HTMLFormElement;
  private readonly titleEl: HTMLElement;
  private readonly levelLegend: HTMLElement;
  private readonly colorLegend: HTMLElement;
  private readonly timeLegend: HTMLElement;
  private readonly unratedNote: HTMLElement;
  private readonly levelHint: HTMLParagraphElement;
  private readonly errorEl: HTMLParagraphElement;
  private readonly submitBtn: HTMLButtonElement;
  private readonly cancelBtn: HTMLButtonElement;

  private pending = false;
  private authenticated = false;

  constructor(opts: PlayBotDialogOptions) {
    this.doc = opts.doc;
    this.callbacks = opts.callbacks;
    this.i18n = opts.i18n;
    const d = this.doc;

    // --- Trigger ---
    // The default button treatment, deliberately not `.cg-trigger`. That class adds weight 600 and
    // roomier padding, which makes "Create a game" the one emphasised action on the lobby; giving
    // this trigger the same treatment would put two equally loud calls to action side by side.
    // DESIGN.md's rule is that hierarchy comes from placement and copy rather than a second button
    // style, so this one stays default and sits below the seek builder.
    this.trigger = el(d, 'button', {
      id: 'play-bot',
      type: 'button',
    });
    this.trigger.textContent = this.i18n.t('bot.title');

    // --- Title ---
    this.titleEl = el(d, 'h2', { id: 'pb-dialog-title' }, this.i18n.t('bot.title'));

    // --- Difficulty fieldset ---
    this.levelHint = el(d, 'p', { class: 'cg-hint', id: 'pb-level-hint' });
    const levelSeg = el(d, 'div', { class: 'cg-segmented' });
    for (const lvl of BOT_LEVELS) {
      levelSeg.append(
        this.segment('pb-level', lvl.id, this.i18n.t(lvl.labelKey), lvl.id === DEFAULT_BOT_LEVEL),
      );
    }
    this.levelLegend = el(d, 'legend', {}, this.i18n.t('bot.level'));
    const levelField = el(
      d,
      'fieldset',
      { class: 'cg-field' },
      this.levelLegend,
      levelSeg,
      this.levelHint,
    );
    for (const radio of levelSeg.querySelectorAll<HTMLInputElement>('input[name="pb-level"]')) {
      radio.setAttribute('aria-describedby', 'pb-level-hint');
    }

    // --- Color fieldset ---
    const colorSeg = el(d, 'div', { class: 'cg-segmented' });
    for (const c of COLOR_OPTIONS) {
      colorSeg.append(
        this.segment('pb-color', c.value, this.i18n.t(c.labelKey), c.value === 'random', c.glyph),
      );
    }
    this.colorLegend = el(d, 'legend', {}, this.i18n.t('bot.color'));
    const colorField = el(
      d,
      'fieldset',
      { class: 'cg-field' },
      this.colorLegend,
      colorSeg,
    );

    // --- Time control fieldset ---
    const presets = el(d, 'div', { class: 'cg-presets' });
    for (const p of TIME_PRESETS) {
      const speed = estimateSpeed(presetToTimeControl(p.minutes, p.increment));
      presets.append(
        this.chip('pb-time', p.id, p.id, p.id === DEFAULT_PRESET_ID, getSpeedLabel(speed, this.i18n)),
      );
    }
    this.timeLegend = el(d, 'legend', {}, this.i18n.t('bot.timeControl'));
    const timeField = el(
      d,
      'fieldset',
      { class: 'cg-field' },
      this.timeLegend,
      presets,
    );

    // --- Unrated notice ---
    this.unratedNote = el(
      d,
      'p',
      { class: 'cg-hint pb-unrated-note' },
      this.i18n.t('bot.unratedNote'),
    );

    // --- Error region ---
    this.errorEl = el(d, 'p', {
      class: 'cg-field-error',
      id: 'pb-error',
      role: 'alert',
      hidden: '',
    });

    // --- Actions ---
    this.submitBtn = el(d, 'button', { type: 'submit', class: 'cg-submit' });
    this.submitBtn.textContent = this.i18n.t('bot.start');
    this.cancelBtn = el(d, 'button', { type: 'button', class: 'cg-cancel' });
    this.cancelBtn.textContent = this.i18n.t('bot.cancel');
    const actions = el(d, 'div', { class: 'cg-actions' }, this.submitBtn, this.cancelBtn);

    // --- Form ---
    this.form = el(d, 'form', { class: 'cg-form' });
    this.form.append(levelField, colorField, timeField, this.unratedNote, this.errorEl, actions);

    // --- Dialog ---
    this.dialog = el(d, 'dialog', {
      class: 'pb-dialog',
      'aria-labelledby': 'pb-dialog-title',
    });
    this.dialog.append(this.titleEl, this.form);

    // --- Event Handlers ---
    this.trigger.addEventListener('click', () => this.open());
    this.cancelBtn.addEventListener('click', () => this.close());
    // A create request cannot be recalled once sent — the game is either created or it is not — so
    // the dialog stays put until it settles. Letting Esc or Cancel dismiss it mid-flight would clear
    // `pending` while the request continued, and the caller would then navigate a player who had
    // just cancelled into a game they no longer wanted, or let them submit a second one.
    this.dialog.addEventListener('cancel', (e) => {
      if (this.pending) e.preventDefault();
    });
    this.dialog.addEventListener('close', () => {
      this.setError(null);
    });
    this.form.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.submit();
    });
    this.form.addEventListener('change', (e) => {
      const t = e.target;
      if (t instanceof HTMLInputElement && t.name === 'pb-level') {
        this.updateLevelHint();
      }
    });

    this.unsubscribeLocale = this.i18n.onLocaleChange(() => {
      this.relocalize();
    });

    opts.mount.replaceChildren(this.trigger, this.dialog);
    this.setAuthenticated(opts.initialAuthenticated ?? false);
    this.updateLevelHint();
  }

  get isOpen(): boolean {
    return this.dialog.open;
  }

  private chip(name: string, value: string, label: string, checked: boolean, speed?: string): HTMLLabelElement {
    const d = this.doc;
    const input = el(d, 'input', { type: 'radio', name, value });
    if (checked) input.checked = true;
    const parts: (Node | string)[] = [input, el(d, 'span', { class: 'cg-chip-label' }, label)];
    if (speed) parts.push(el(d, 'span', { class: 'cg-chip-speed' }, speed));
    return el(d, 'label', { class: 'cg-chip' }, ...parts);
  }

  private segment(name: string, value: string, label: string, checked: boolean, glyph?: string): HTMLLabelElement {
    const d = this.doc;
    const input = el(d, 'input', { type: 'radio', name, value });
    if (checked) input.checked = true;
    const inner = el(d, 'span', { class: 'cg-seg-label' });
    if (glyph) inner.append(el(d, 'span', { class: 'cg-seg-glyph', 'aria-hidden': 'true' }, glyph));
    inner.append(label);
    return el(d, 'label', { class: 'cg-seg' }, input, inner);
  }

  private readChecked(name: string): string | null {
    const input = this.form.querySelector<HTMLInputElement>(`input[name="${name}"]:checked`);
    return input ? input.value : null;
  }

  private updateLevelHint(): void {
    const selectedId = parseBotLevel(this.readChecked('pb-level'));
    const option = BOT_LEVELS.find((opt) => opt.id === selectedId);
    this.levelHint.textContent = option ? this.i18n.t(option.blurbKey) : '';
  }

  private gather(): CreateBotGameParams {
    const level = parseBotLevel(this.readChecked('pb-level'));
    const color = (this.readChecked('pb-color') ?? 'random') as SeekColor;
    const timeVal = this.readChecked('pb-time') ?? DEFAULT_PRESET_ID;
    const preset =
      TIME_PRESETS.find((p) => p.id === timeVal) ??
      TIME_PRESETS.find((p) => p.id === DEFAULT_PRESET_ID)!;
    const timeControl = presetToTimeControl(preset.minutes, preset.increment);

    return { level, color, timeControl };
  }

  private async submit(): Promise<void> {
    if (this.pending) return;
    const params = this.gather();
    this.setError(null);
    this.setPending(true);

    try {
      const gameId = await this.callbacks.onSubmit(params);
      if (!gameId) {
        this.setPending(false);
      }
      // On success, the caller navigates. Leave pending and open so there is no UI flash.
    } catch (err) {
      this.setError(err instanceof Error ? err.message : String(err));
      this.setPending(false);
    }
  }

  open(): void {
    this.dialog.showModal();
    const checked = this.form.querySelector<HTMLInputElement>('input[name="pb-level"]:checked');
    checked?.focus();
  }

  close(): void {
    // Mirrors the `cancel` guard: nothing dismisses the dialog while a create request is settling.
    if (this.pending) return;
    this.dialog.close();
    if (!this.trigger.disabled) {
      this.trigger.focus();
    }
  }

  setError(message: string | null): void {
    if (message) {
      this.errorEl.textContent = message;
      this.errorEl.hidden = false;
    } else {
      this.errorEl.textContent = '';
      this.errorEl.hidden = true;
    }
  }

  setPending(pending: boolean): void {
    this.pending = pending;
    this.submitBtn.disabled = pending;
    this.submitBtn.textContent = pending
      ? this.i18n.t('bot.starting')
      : this.i18n.t('bot.start');
    this.cancelBtn.disabled = pending;
  }

  setAuthenticated(authed: boolean): void {
    this.authenticated = authed;
    this.trigger.disabled = !authed;
    this.trigger.title = authed
      ? ''
      : this.i18n.t('bot.signInToPlay');
    if (!authed && this.dialog.open) {
      this.close();
    }
  }

  relocalize(): void {
    this.trigger.textContent = this.i18n.t('bot.title');
    this.titleEl.textContent = this.i18n.t('bot.title');
    this.levelLegend.textContent = this.i18n.t('bot.level');
    this.colorLegend.textContent = this.i18n.t('bot.color');
    this.timeLegend.textContent = this.i18n.t('bot.timeControl');
    this.unratedNote.textContent = this.i18n.t('bot.unratedNote');
    this.cancelBtn.textContent = this.i18n.t('bot.cancel');
    this.submitBtn.textContent = this.pending ? this.i18n.t('bot.starting') : this.i18n.t('bot.start');
    if (!this.authenticated) {
      this.trigger.title = this.i18n.t('bot.signInToPlay');
    }

    // Retranslate difficulty option labels without disturbing checked radio states
    for (const lvl of BOT_LEVELS) {
      const radio = this.form.querySelector<HTMLInputElement>(`input[name="pb-level"][value="${lvl.id}"]`);
      const segLabel = radio?.closest('label')?.querySelector('.cg-seg-label');
      if (segLabel) {
        segLabel.textContent = this.i18n.t(lvl.labelKey);
      }
    }

    // Retranslate color option labels without disturbing checked radio states
    for (const c of COLOR_OPTIONS) {
      const radio = this.form.querySelector<HTMLInputElement>(`input[name="pb-color"][value="${c.value}"]`);
      const segLabel = radio?.closest('label')?.querySelector('.cg-seg-label');
      if (segLabel) {
        segLabel.replaceChildren(
          el(this.doc, 'span', { class: 'cg-seg-glyph', 'aria-hidden': 'true' }, c.glyph),
          this.doc.createTextNode(this.i18n.t(c.labelKey)),
        );
      }
    }

    // Retranslate time preset speed chips without disturbing checked radio states
    for (const p of TIME_PRESETS) {
      const radio = this.form.querySelector<HTMLInputElement>(`input[name="pb-time"][value="${p.id}"]`);
      const speedSpan = radio?.closest('label')?.querySelector('.cg-chip-speed');
      if (speedSpan) {
        const speed = estimateSpeed(presetToTimeControl(p.minutes, p.increment));
        speedSpan.textContent = getSpeedLabel(speed, this.i18n);
      }
    }

    this.updateLevelHint();
  }

  dispose(): void {
    this.unsubscribeLocale();
  }
}
