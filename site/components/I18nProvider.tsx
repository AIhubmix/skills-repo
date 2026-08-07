"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";

import { DEFAULT_LOCALE, LOCALE_STORAGE_KEY, MESSAGES, formatMessage, isLocale, type Locale, type MessageKey } from "@/lib/i18n";

type I18nContextValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: MessageKey, params?: Record<string, string | number>) => string;
};

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);

  // Detect locale from URL path
  useEffect(() => {
    const segments = pathname.split('/').filter(Boolean);
    const firstSegment = segments[0];

    // Check if first segment is a valid locale
    if (firstSegment && isLocale(firstSegment)) {
      setLocaleState(firstSegment as Locale);
      // Sync to localStorage
      window.localStorage.setItem(LOCALE_STORAGE_KEY, firstSegment);
    } else {
      // Default path (no locale prefix) - check localStorage
      const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY) ?? "";
      if (stored && isLocale(stored)) {
        setLocaleState(stored);
      }
    }
  }, [pathname]);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    window.localStorage.setItem(LOCALE_STORAGE_KEY, next);

    // Navigate to the new locale
    const segments = window.location.pathname.split('/').filter(Boolean);
    const firstSegment = segments[0];

    let newPath;

    // Check if current path has a locale prefix
    if (firstSegment && isLocale(firstSegment)) {
      // Replace the locale prefix
      const pathWithoutLocale = '/' + segments.slice(1).join('/');
      newPath = '/' + next + pathWithoutLocale;
    } else {
      // Current path has no locale prefix, add one
      newPath = '/' + next + window.location.pathname;
    }

    // Navigate
    if (newPath !== window.location.pathname) {
      window.location.href = newPath;
    }
  }, []);

  const t = useCallback(
    (key: MessageKey, params?: Record<string, string | number>) => {
      const msg = MESSAGES[locale]?.[key] ?? MESSAGES[DEFAULT_LOCALE][key] ?? key;
      return formatMessage(msg, params, locale);
    },
    [locale]
  );

  const value = useMemo<I18nContextValue>(() => ({ locale, setLocale, t }), [locale, setLocale, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n must be used within an I18nProvider");
  return ctx;
}


