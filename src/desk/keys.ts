/**
 * Key combinations like `cmd+k` or `shift+enter`, checked before anything
 * reaches the OS. The set of names matches native/desk-helper.swift — a name
 * outside it is a mistake the model hears about right away, instead of a
 * keystroke that silently does nothing.
 */
type Modifier = 'cmd' | 'shift' | 'alt' | 'ctrl' | 'fn';

export interface KeyCombo {
  readonly modifiers: readonly Modifier[];
  readonly key: string;
}

const MODIFIER_ALIASES: Readonly<Record<string, Modifier>> = {
  cmd: 'cmd',
  command: 'cmd',
  shift: 'shift',
  alt: 'alt',
  option: 'alt',
  opt: 'alt',
  ctrl: 'ctrl',
  control: 'ctrl',
  fn: 'fn',
};

const KEY_ALIASES: Readonly<Record<string, string>> = {
  enter: 'return',
  esc: 'escape',
  backspace: 'delete',
};

const NAMED_KEYS = [
  'return',
  'tab',
  'space',
  'delete',
  'forwarddelete',
  'escape',
  'up',
  'down',
  'left',
  'right',
  'home',
  'end',
  'pageup',
  'pagedown',
  ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`),
];

const KEYS = new Set([...'abcdefghijklmnopqrstuvwxyz0123456789', ..."-=[]\\;',./`", ...NAMED_KEYS]);

/** Fixed order, so `shift+cmd+k` and `cmd+shift+k` are the same combo. */
const MODIFIER_ORDER: readonly Modifier[] = ['ctrl', 'alt', 'shift', 'cmd', 'fn'];

export class KeyComboError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyComboError';
  }
}

export function parseKeyCombo(text: string): KeyCombo {
  const parts = text
    .toLowerCase()
    .split('+')
    .map((part) => part.trim());
  const rawKey = parts.pop();
  if (!rawKey) throw new KeyComboError(`Empty key in "${text}"`);

  const modifiers = new Set<Modifier>();
  for (const part of parts) {
    const modifier = MODIFIER_ALIASES[part];
    if (!modifier) {
      throw new KeyComboError(
        `Unknown modifier "${part}" in "${text}". Use: cmd, shift, alt (option), ctrl, fn.`,
      );
    }
    modifiers.add(modifier);
  }

  const key = KEY_ALIASES[rawKey] ?? rawKey;
  if (!KEYS.has(key)) {
    throw new KeyComboError(
      `Unknown key "${rawKey}" in "${text}". Use a letter, digit, punctuation, or one of: ${NAMED_KEYS.join(', ')}.`,
    );
  }
  return { modifiers: MODIFIER_ORDER.filter((m) => modifiers.has(m)), key };
}

/** Canonical `mod+mod+key` form — what the native helper reads. */
export function formatKeyCombo(combo: KeyCombo): string {
  return [...combo.modifiers, combo.key].join('+');
}
