/**
 * customizer.js: Pet Creator / Customizer sheet. Live-edits name, colours,
 * ear and tail style, proportions and temperament. Every change previews on
 * the 3D pet immediately; Save commits it, Cancel restores the original.
 * On first launch it doubles as the "create and name your pet" step.
 */
import {
  EAR_STYLES, TAIL_STYLES, TRAITS, TRAIT_LABELS, TRAIT_HINTS, TEMPERAMENT_PRESETS, COLOR_SWATCHES,
  APPEARANCE_LIMITS, sanitizeAppearance, sanitizeTraits, sanitizeName, randomAppearance, randomTraits,
} from './pet-state.js';

const EAR_LABELS = { round: 'Round', cat: 'Cat', bunny: 'Bunny', horns: 'Horns' };
const TAIL_LABELS = { puff: 'Puff', long: 'Long', star: 'Star' };
const COLOR_FIELDS = [['bodyColor', 'Body', 'body'], ['accentColor', 'Accent', 'accent'], ['cheekColor', 'Cheeks', 'cheek']];
const head = '<path d="M5 20.5a7 7 0 0 1 14 0"/>';
const SHAPE_SVG = {
  round: `${head}<circle cx="7.5" cy="10" r="3"/><circle cx="16.5" cy="10" r="3"/>`,
  cat: `${head}<path d="M6 14 7 5.5l4 5M18 14l-1-8.5-4 5"/>`,
  bunny: `${head}<ellipse cx="9" cy="7.5" rx="2" ry="5"/><ellipse cx="15" cy="7.5" rx="2" ry="5"/>`,
  horns: `${head}<path d="M8.5 13c-2-1-3-4.2-1.4-7.4 0 3.2 1.5 4.7 3.4 5.4M15.5 13c2-1 3-4.2 1.4-7.4 0 3.2-1.5 4.7-3.4 5.4"/>`,
  puff: '<circle cx="12" cy="13.5" r="5"/><circle cx="7.4" cy="10" r="3"/><circle cx="16.6" cy="10" r="3"/>',
  long: '<path d="M4 18.5c4 0 6-3 7-7s3-6.5 8-6.5"/><circle cx="19" cy="5" r="1.8"/>',
  star: '<path d="M12 4l2.2 4.6 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5L4.8 9.3l5-.7L12 4z"/>',
};
const shapeIcon = (k) => `<svg class="ico" viewBox="0 0 24 24" aria-hidden="true">${SHAPE_SVG[k]}</svg>`;
const useIcon = (id) => `<svg class="ico" aria-hidden="true"><use href="#${id}"></use></svg>`;

export class Customizer {
  constructor({ onPreview, onClose } = {}) {
    this.dialog = document.getElementById('customizer');
    this.onPreview = onPreview;
    this.onClose = onClose;
    this.state = null;
    this.original = null;
    this.firstRun = false;
    this._build();
    this.dialog.addEventListener('cancel', (e) => {
      e.preventDefault(); // Escape behaves like Cancel (and is ignored on first run)
      if (!this.firstRun) this.close(false);
    });
  }

  get isOpen() {
    return this.dialog.open;
  }

  panelRect() {
    return this.dialog.getBoundingClientRect();
  }

  _build() {
    const L = APPEARANCE_LIMITS;
    const colorRows = COLOR_FIELDS.map(([field, label, key]) => `
      <div class="cz-color-row">
        <span id="cz-l-${field}">${label}</span>
        <div class="swatches" role="radiogroup" aria-labelledby="cz-l-${field}" data-color="${field}">
          ${COLOR_SWATCHES[key].map((c) => `<button type="button" class="swatch" role="radio" aria-checked="false" aria-label="${label} colour ${c}" data-value="${c}" style="--sw:${c}"></button>`).join('')}
          <label class="swatch custom" title="Custom ${label.toLowerCase()} colour"><input type="color" data-custom="${field}" aria-label="Custom ${label.toLowerCase()} colour"></label>
        </div>
      </div>`).join('');
    const chips = (group, list, labels) => list.map((k) => `
      <button type="button" class="chip" role="radio" aria-checked="false" data-group="${group}" data-value="${k}">${shapeIcon(k)}${labels[k]}</button>`).join('');
    const slider = (field, label, min, max, step, hint = '') => `
      <label class="slider-row"${hint ? ` title="${hint}"` : ''}><span>${label}</span>
        <input type="range" data-field="${field}" min="${min}" max="${max}" step="${step}" aria-label="${label}"><output data-out="${field}"></output>
      </label>`;
    this.dialog.innerHTML = `
      <div class="cz-head">
        <div><h2 id="cz-title" tabindex="-1" autofocus>Customize Pet</h2><p class="sheet-sub" id="cz-sub">Changes preview live on your pet.</p></div>
        <button class="icon-btn" type="button" data-cz="cancel" aria-label="Close">${useIcon('i-close')}</button>
      </div>
      <div class="cz-body">
        <section class="cz-sec cz-name"><h3><label for="cz-name">Name</label></h3>
          <input id="cz-name" type="text" maxlength="${L.nameMax}" autocomplete="off" autocapitalize="words" spellcheck="false" enterkeyhint="done">
        </section>
        <section class="cz-sec"><h3>Colours</h3>${colorRows}</section>
        <section class="cz-sec"><h3 id="cz-ears">Ears</h3><div class="chips" role="radiogroup" aria-labelledby="cz-ears">${chips('earStyle', EAR_STYLES, EAR_LABELS)}</div></section>
        <section class="cz-sec"><h3 id="cz-tail">Tail</h3><div class="chips" role="radiogroup" aria-labelledby="cz-tail">${chips('tailStyle', TAIL_STYLES, TAIL_LABELS)}</div></section>
        <section class="cz-sec"><h3>Proportions</h3>
          ${slider('headScale', 'Head size', L.headScale[0], L.headScale[1], 0.01)}
          ${slider('bodyScale', 'Body size', L.bodyScale[0], L.bodyScale[1], 0.01)}
        </section>
        <section class="cz-sec"><h3 id="cz-temp">Temperament</h3>
          <div class="chips" role="group" aria-labelledby="cz-temp">
            ${Object.entries(TEMPERAMENT_PRESETS).map(([id, p]) => `<button type="button" class="chip" data-preset="${id}">${p.label}</button>`).join('')}
          </div>
          <div class="cz-traits">${TRAITS.map((t) => slider(`trait:${t}`, TRAIT_LABELS[t], 0, 100, 1, TRAIT_HINTS[t])).join('')}</div>
          <p class="cz-note">Temperament steers the hand-written care and autonomy rules: what your pet chooses to do and how it reacts. It is not machine learning. Real learning arrives later with teaching and sleep practice.</p>
        </section>
      </div>
      <div class="cz-foot">
        <button class="btn" type="button" data-cz="random">${useIcon('i-dice')}Randomize</button>
        <span class="grow"></span>
        <button class="btn" type="button" data-cz="cancel" data-cz-cancel>Cancel</button>
        <button class="btn primary" type="button" data-cz="save">${useIcon('i-check')}<span data-cz-save>Save</span></button>
      </div>`;
    this._wire();
  }

  _wire() {
    const d = this.dialog;
    this.nameInput = d.querySelector('#cz-name');
    this.nameInput.addEventListener('input', () => {
      this.state.appearance.name = sanitizeName(this.nameInput.value) || this.original.appearance.name;
      this._preview();
    });
    this.nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.nameInput.blur();
    });
    d.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || !this.state) return;
      const swatchGroup = b.closest('[data-color]');
      if (b.classList.contains('swatch') && swatchGroup) {
        this.state.appearance[swatchGroup.dataset.color] = b.dataset.value;
      } else if (b.dataset.group) {
        this.state.appearance[b.dataset.group] = b.dataset.value;
      } else if (b.dataset.preset) {
        this.state.traits = { ...TEMPERAMENT_PRESETS[b.dataset.preset].traits };
      } else if (b.dataset.cz === 'random') {
        const keepName = this.state.appearance.name;
        this.state.appearance = { ...randomAppearance(), name: keepName };
        this.state.traits = randomTraits();
      } else if (b.dataset.cz === 'save') {
        this.close(true);
        return;
      } else if (b.dataset.cz === 'cancel') {
        this.close(false);
        return;
      } else {
        return;
      }
      this._sync();
      this._preview();
    });
    d.addEventListener('input', (e) => {
      const t = e.target;
      if (!this.state) return;
      if (t.dataset.custom) {
        this.state.appearance[t.dataset.custom] = t.value;
      } else if (t.dataset.field?.startsWith('trait:')) {
        this.state.traits[t.dataset.field.slice(6)] = Number(t.value) / 100;
      } else if (t.dataset.field) {
        this.state.appearance[t.dataset.field] = Number(t.value);
      } else {
        return;
      }
      this._sync(false);
      this._preview();
    });
  }

  /** Reflects the working state in the form controls. */
  _sync(includeName = true) {
    const { appearance: a, traits } = this.state;
    const d = this.dialog;
    if (includeName) this.nameInput.value = a.name;
    for (const group of d.querySelectorAll('[data-color]')) {
      const field = group.dataset.color;
      let matched = false;
      for (const sw of group.querySelectorAll('.swatch[data-value]')) {
        const on = sw.dataset.value.toLowerCase() === a[field].toLowerCase();
        matched ||= on;
        sw.setAttribute('aria-checked', String(on));
      }
      const custom = group.querySelector('input[type="color"]');
      custom.value = a[field];
      custom.closest('.swatch').setAttribute('aria-checked', String(!matched));
    }
    for (const chip of d.querySelectorAll('.chip[data-group]')) {
      chip.setAttribute('aria-checked', String(a[chip.dataset.group] === chip.dataset.value));
    }
    for (const input of d.querySelectorAll('input[type="range"]')) {
      const f = input.dataset.field;
      const out = d.querySelector(`[data-out="${CSS.escape(f)}"]`);
      if (f.startsWith('trait:')) {
        const v = Math.round(traits[f.slice(6)] * 100);
        input.value = String(v);
        out.textContent = String(v);
      } else {
        input.value = String(a[f]);
        out.textContent = `${Math.round(a[f] * 100)}%`;
      }
    }
  }

  _preview() {
    this.onPreview?.(sanitizeAppearance(this.state.appearance), sanitizeTraits(this.state.traits));
  }

  /**
   * Opens the sheet. `firstRun` turns it into the pet creator (no cancel).
   */
  open({ appearance, traits, firstRun = false }) {
    this.original = { appearance: { ...appearance }, traits: { ...traits } };
    this.state = { appearance: { ...appearance }, traits: { ...traits } };
    this.firstRun = firstRun;
    const d = this.dialog;
    d.querySelector('#cz-title').textContent = firstRun ? 'Meet your new pet!' : 'Customize Pet';
    d.querySelector('#cz-sub').textContent = firstRun
      ? 'Give it a name, a look and a temperament. You can change these any time.'
      : 'Changes preview live on your pet.';
    d.querySelector('[data-cz-save]').textContent = firstRun ? 'Start' : 'Save';
    for (const b of d.querySelectorAll('[data-cz="cancel"]')) b.hidden = firstRun;
    this._sync();
    if (!d.open) d.showModal();
    d.querySelector('.cz-body').scrollTop = 0;
  }

  /** Closes the sheet; `save` commits the edited appearance and temperament. */
  close(save) {
    if (!this.dialog.open || !this.state) return;
    const appearance = sanitizeAppearance({
      ...this.state.appearance,
      name: sanitizeName(this.nameInput.value) || this.original.appearance.name,
    });
    const result = save
      ? { saved: true, firstRun: this.firstRun, appearance, traits: sanitizeTraits(this.state.traits) }
      : { saved: false, firstRun: this.firstRun, appearance: this.original.appearance, traits: this.original.traits };
    this.dialog.close();
    this.state = null;
    this.onClose?.(result);
  }
}
