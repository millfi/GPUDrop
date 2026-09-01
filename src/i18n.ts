export type UiLanguage = "ja" | "en";

export function getUiLanguage(locale?: string): UiLanguage {
  const resolvedLocale =
    locale ?? (typeof navigator === "undefined" ? "en" : navigator.language);
  return resolvedLocale.toLowerCase().startsWith("ja") ? "ja" : "en";
}

export const uiLanguage = getUiLanguage();

export function t(japanese: string, english: string) {
  return uiLanguage === "ja" ? japanese : english;
}
