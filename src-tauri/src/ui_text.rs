//! App-owned native copy comes from the same catalogues as the renderer.
//! The renderer chooses only one validated locale, never confirmation text.
use serde::Deserialize;
use serde_json::Value;
use std::sync::OnceLock;

#[derive(Clone, Copy, Debug, Default, Deserialize)]
pub(crate) enum UiLocale {
    #[default]
    #[serde(rename = "en")]
    En,
    #[serde(rename = "fr")]
    Fr,
    #[serde(rename = "es")]
    Es,
    #[serde(rename = "pl")]
    Pl,
    #[serde(rename = "pt-BR")]
    PtBr,
}

impl UiLocale {
    fn catalogue(self) -> &'static Value {
        static EN: OnceLock<Value> = OnceLock::new();
        static FR: OnceLock<Value> = OnceLock::new();
        static ES: OnceLock<Value> = OnceLock::new();
        static PL: OnceLock<Value> = OnceLock::new();
        static PT: OnceLock<Value> = OnceLock::new();
        let (slot, text) = match self {
            Self::En => (
                &EN,
                include_str!("../../src/i18n/locales/interface-en.json"),
            ),
            Self::Fr => (
                &FR,
                include_str!("../../src/i18n/locales/interface-fr.json"),
            ),
            Self::Es => (
                &ES,
                include_str!("../../src/i18n/locales/interface-es.json"),
            ),
            Self::Pl => (
                &PL,
                include_str!("../../src/i18n/locales/interface-pl.json"),
            ),
            Self::PtBr => (
                &PT,
                include_str!("../../src/i18n/locales/interface-pt-BR.json"),
            ),
        };
        slot.get_or_init(|| serde_json::from_str(text).expect("bundled interface catalogue"))
    }

    pub(crate) fn text(self, key: &str) -> &'static str {
        self.catalogue()[key]
            .as_str()
            .expect("bundled native text key")
    }

    /// Replace only the template's own placeholders in one pass. A path or
    /// label containing braces must never introduce another substitution.
    pub(crate) fn render(self, key: &str, values: &[(&str, &str)]) -> String {
        interpolate(self.text(key), values)
    }

    /// Nonnegative native counts follow the same grouping convention as Intl
    /// for the five shipped locales, without accepting renderer-supplied counts.
    fn number(self, count: usize) -> String {
        let digits = count.to_string();
        if matches!(self, Self::Es | Self::Pl) && digits.len() <= 4 {
            return digits;
        }
        let separator = match self {
            Self::En => ",",
            Self::Fr => "\u{202f}",
            Self::Pl => "\u{a0}",
            Self::Es | Self::PtBr => ".",
        };
        let mut result = String::new();
        for (index, digit) in digits.chars().enumerate() {
            if index > 0 && (digits.len() - index).is_multiple_of(3) {
                result.push_str(separator);
            }
            result.push(digit);
        }
        result
    }

    /// The typed guard is native-owned too. Only canonical NFC/NFD
    /// equivalence is accepted: no case folding, compatibility normalization
    /// or whitespace relaxation. Bound work before normalization.
    pub(crate) fn reset_phrase_matches(self, typed: &str) -> bool {
        use unicode_normalization::UnicodeNormalization;
        let phrase = self.text("native.reset.phrase");
        let max_bytes: usize = phrase.nfd().map(char::len_utf8).sum();
        typed.len() <= max_bytes && typed.nfc().eq(phrase.nfc())
    }

    pub(crate) fn documents(self, count: usize) -> String {
        let category = match self {
            Self::Pl if count == 1 => "one",
            Self::Pl if (2..=4).contains(&(count % 10)) && !(12..=14).contains(&(count % 100)) => {
                "few"
            }
            Self::Pl => "many",
            Self::Fr | Self::PtBr if count <= 1 => "one",
            Self::Fr | Self::Es | Self::PtBr if count > 0 && count.is_multiple_of(1_000_000) => {
                "many"
            }
            _ if count == 1 => "one",
            _ => "other",
        };
        let forms = &self.catalogue()["interface.count.documents"];
        let template = forms
            .get(category)
            .or_else(|| forms.get("other"))
            .and_then(Value::as_str)
            .expect("bundled document plural");
        interpolate(template, &[("count", &self.number(count))])
    }
}

fn interpolate(template: &str, values: &[(&str, &str)]) -> String {
    let mut result = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        result.push_str(&rest[..open]);
        let tail = &rest[open + 1..];
        let Some(close) = tail.find('}') else {
            result.push_str(&rest[open..]);
            return result;
        };
        match values.iter().find(|(name, _)| *name == &tail[..close]) {
            Some((_, value)) => result.push_str(value),
            None => result.push_str(&rest[open..open + close + 2]),
        }
        rest = &tail[close + 1..];
    }
    result.push_str(rest);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_localization_locale_is_validated_and_user_values_are_never_reparsed() {
        for tag in ["en", "fr", "es", "pl", "pt-BR"] {
            assert!(serde_json::from_value::<UiLocale>(Value::String(tag.to_owned())).is_ok());
        }
        for value in [
            Value::String("de".to_owned()),
            Value::String("{kept}".to_owned()),
            Value::Bool(true),
            Value::Null,
        ] {
            assert!(serde_json::from_value::<UiLocale>(value).is_err());
        }
        let path = "/FAKE/{kept}/é";
        for locale in [
            UiLocale::En,
            UiLocale::Fr,
            UiLocale::Es,
            UiLocale::Pl,
            UiLocale::PtBr,
        ] {
            let text = locale.render("native.setAside.desktop", &[("folder", path)]);
            assert!(text.contains(path));
            assert!(!text.contains("{folder}"));
            let kit = locale.render(
                "native.kit.text",
                &[
                    ("key", "FAKE-KEY"),
                    ("label", "FAKE"),
                    ("date", "2026-10-23"),
                ],
            );
            assert!(kit.contains("FAKE-KEY") && kit.contains("2026-10-23") && kit.ends_with('\n'));
            assert!(!kit.contains("{key}") && !kit.contains("{label}") && !kit.contains("{date}"));
        }
    }
    #[test]
    fn native_localization_restoration_counts_use_polish_plurals_and_locale_grouping() {
        assert_eq!(UiLocale::Pl.documents(1), "1 dokument");
        assert_eq!(UiLocale::Pl.documents(2), "2 dokumenty");
        assert_eq!(UiLocale::Pl.documents(5), "5 dokumentów");
        assert_eq!(UiLocale::Pl.documents(12), "12 dokumentów");
        assert_eq!(UiLocale::Pl.documents(22), "22 dokumenty");
        assert_eq!(UiLocale::En.number(12345), "12,345");
        assert_eq!(UiLocale::Fr.number(12345), "12\u{202f}345");
        assert_eq!(UiLocale::Pl.number(12345), "12\u{a0}345");
        assert_eq!(UiLocale::Es.number(12345), "12.345");
        assert_eq!(UiLocale::PtBr.number(12345), "12.345");
    }
}

#[cfg(test)]
mod reset_tests {
    use super::*;
    use unicode_normalization::UnicodeNormalization;
    #[test]
    fn native_localization_reset_guard_accepts_only_its_own_language_and_canonical_accents() {
        let locales = [
            UiLocale::En,
            UiLocale::Fr,
            UiLocale::Es,
            UiLocale::Pl,
            UiLocale::PtBr,
        ];
        for (index, locale) in locales.iter().copied().enumerate() {
            let phrase = locale.text("native.reset.phrase");
            assert!(locale.reset_phrase_matches(phrase));
            assert!(locale.reset_phrase_matches(&phrase.nfd().collect::<String>()));
            assert!(!locale.reset_phrase_matches(&phrase.to_lowercase()));
            assert!(!locale.reset_phrase_matches(&format!(" {phrase}")));
            assert!(!locale.reset_phrase_matches(&format!("{phrase} ")));
            assert!(!locale.reset_phrase_matches("FAKE"));
            assert!(!locale.reset_phrase_matches(
                locales[(index + 1) % locales.len()].text("native.reset.phrase")
            ));
        }
        assert!(UiLocale::default().reset_phrase_matches("RESET MYCARLOS VAULT"));
        assert!(!UiLocale::En.reset_phrase_matches("ＲＥＳＥＴ ＭＹＣＡＲＬＯＳ ＶＡＵＬＴ"));
    }
}
