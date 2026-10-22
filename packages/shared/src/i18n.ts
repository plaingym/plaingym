// SPDX-License-Identifier: AGPL-3.0-only
export type Messages = Readonly<Record<string, string>>;
export type LocaleCatalog = Readonly<Record<string, Messages>>;
export type TranslationValues = Readonly<Record<string, string | number>>;
export type Translator = (key: string, values?: TranslationValues) => string;

// A key is "<area>/<part>:<message>". Missing keys remain visible during development.
export function createTranslator(catalog: LocaleCatalog): Translator {
  return (key, values = {}) => {
    const separator = key.indexOf(':');
    const namespace = key.slice(0, separator);
    const message = key.slice(separator + 1);
    const template =
      separator > 0 && Object.hasOwn(catalog, namespace) && Object.hasOwn(catalog[namespace] ?? {}, message)
        ? catalog[namespace]?.[message]
        : undefined;
    return (template ?? key).replace(/\{([a-zA-Z0-9_]+)\}/g, (placeholder: string, name: string) =>
      Object.hasOwn(values, name) ? String(values[name]) : placeholder,
    );
  };
}
