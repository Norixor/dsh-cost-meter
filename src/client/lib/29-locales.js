// Dictionaries registered next to zh and en. The host ships only zh and en; these take effect when the active language
// is one of them (typically through a language pack plugin that defines the language). Ids are lowercase, like the
// ids of `locale/<id>.json`; a missing key falls back along the language's chain to English.
const EXTRA_LOCALES = {
  'zh-hant': ZH_HANT,
  ja: JA,
  ko: KO,
  de: DE,
  fr: FR,
  es: ES,
  ru: RU,
}
