// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useId, useRef, useState } from 'react';
import type { InputHTMLAttributes } from 'react';
import { useAppearance } from '../../app/runtime';
import { languageName } from '../format';

const languageCodes = [
  'en', 'ja', 'es', 'fr', 'de', 'ko', 'zh', 'it', 'pt', 'ru', 'ar',
  'hi', 'vi', 'th', 'id', 'nl', 'sv', 'pl', 'tr', 'uk',
];

type LanguageInputProps = Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'value' | 'onChange' | 'list'
> & {
  value: string;
  onChange: (code: string) => void;
};

/** Shows language names while preserving arbitrary existing language codes. */
export function LanguageInput({ value, onChange, ...props }: LanguageInputProps) {
  const { locale, t } = useAppearance();
  const id = useId();
  const choices = languageCodes.map((code) => ({
    code,
    name: languageName(code, locale || 'en'),
  }));
  const display = (code: string) =>
    choices.find((choice) => choice.code === code)?.name || code;
  const [text, setText] = useState(() => display(value));
  const emitted = useRef<string | undefined>(undefined);
  const previousLocale = useRef(locale);

  useEffect(() => {
    if (value !== emitted.current || previousLocale.current !== locale)
      setText(display(value));
    previousLocale.current = locale;
  }, [value, locale]);

  return (
    <>
      <input
        {...props}
        list={id}
        value={text}
        placeholder={t('言語名を選択、またはコードを入力', 'Choose a language or enter a code')}
        onChange={(event) => {
          const input = event.target.value;
          setText(input);
          const choice = choices.find(
            (item) => item.name.toLocaleLowerCase() === input.trim().toLocaleLowerCase(),
          );
          emitted.current = choice?.code || input;
          onChange(emitted.current);
        }}
        onBlur={(event) => {
          setText(display(value));
          props.onBlur?.(event);
        }}
      />
      <datalist id={id}>
        {choices.map((choice) => (
          <option key={choice.code} value={choice.name} label={choice.code} />
        ))}
      </datalist>
    </>
  );
}
