import { createContext, createElement, useContext, useMemo, type ReactNode } from 'react';
import { zh } from './locales/zh';
import { en } from './locales/en';
import type { Dictionary } from './locales/zh';

export type Locale = 'zh' | 'en';

export const LOCALES: Locale[] = ['zh', 'en'];

export const LOCALE_LABELS: Record<Locale, string> = {
  zh: '中文',
  en: 'English',
};

const DICTIONARIES: Record<Locale, Dictionary> = { zh, en };

const LOCALE_STORAGE_KEY = 'fastnote_locale';

export function detectDefaultLocale(): Locale {
  if (typeof navigator === 'undefined') return 'zh';
  return navigator.language?.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export function loadLocale(): Locale {
  if (typeof localStorage === 'undefined') return detectDefaultLocale();
  const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
  if (stored === 'zh' || stored === 'en') return stored;
  return detectDefaultLocale();
}

export function saveLocale(locale: Locale): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(LOCALE_STORAGE_KEY, locale);
}

type Vars = Record<string, string | number>;

function resolvePath(dict: Dictionary, path: string): unknown {
  return path.split('.').reduce<unknown>((node, segment) => {
    if (node && typeof node === 'object' && segment in node) {
      return (node as Record<string, unknown>)[segment];
    }
    return undefined;
  }, dict);
}

function interpolate(template: string, vars?: Vars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in vars ? String(vars[key]) : match,
  );
}

/** Pure translation lookup — safe to call outside React (utils, non-component modules). */
export function translate(locale: Locale, key: string, vars?: Vars): string {
  const value = resolvePath(DICTIONARIES[locale], key) ?? resolvePath(DICTIONARIES.zh, key);
  if (typeof value !== 'string') return key;
  return interpolate(value, vars);
}

export type TFunction = (key: string, vars?: Vars) => string;

interface I18nContextValue {
  locale: Locale;
  t: TFunction;
}

const I18nContext = createContext<I18nContextValue>({
  locale: 'zh',
  t: (key: string, vars?: Vars) => translate('zh', key, vars),
});

export function I18nProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  const value = useMemo<I18nContextValue>(
    () => ({ locale, t: (key: string, vars?: Vars) => translate(locale, key, vars) }),
    [locale],
  );
  return createElement(I18nContext.Provider, { value }, children);
}

/** Returns the translate function bound to the current locale. */
export function useT(): TFunction {
  return useContext(I18nContext).t;
}

export function useLocale(): Locale {
  return useContext(I18nContext).locale;
}
