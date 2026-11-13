//! Native UI copy is formatted from the same Fluent resources as the renderer.
//! The renderer may choose only a validated locale; it never supplies message text.
use crate::ui_text_ids::MessageId;
use fluent_bundle::{FluentArgs, FluentBundle, FluentResource};
use serde::Deserialize;
use std::cell::RefCell;
use std::collections::HashMap;
use unicode_normalization::UnicodeNormalization;

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, Hash, PartialEq)]
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
    #[serde(rename = "zh-CN")]
    ZhCn,
    #[serde(rename = "zh-TW")]
    ZhTw,
}

impl UiLocale {
    const ALL: [Self; 7] = [
        Self::En,
        Self::Fr,
        Self::Es,
        Self::Pl,
        Self::PtBr,
        Self::ZhCn,
        Self::ZhTw,
    ];

    fn tag(self) -> &'static str {
        match self {
            Self::En => "en",
            Self::Fr => "fr",
            Self::Es => "es",
            Self::Pl => "pl",
            Self::PtBr => "pt-BR",
            Self::ZhCn => "zh-CN",
            Self::ZhTw => "zh-TW",
        }
    }

    fn source(self) -> &'static str {
        match self {
            Self::En => include_str!("../../src/i18n/locales/fluent/en.ftl"),
            Self::Fr => include_str!("../../src/i18n/locales/fluent/fr.ftl"),
            Self::Es => include_str!("../../src/i18n/locales/fluent/es.ftl"),
            Self::Pl => include_str!("../../src/i18n/locales/fluent/pl.ftl"),
            Self::PtBr => include_str!("../../src/i18n/locales/fluent/pt-BR.ftl"),
            Self::ZhCn => include_str!("../../src/i18n/locales/fluent/zh-CN.ftl"),
            Self::ZhTw => include_str!("../../src/i18n/locales/fluent/zh-TW.ftl"),
        }
    }

    fn with_bundle<T>(self, operation: impl FnOnce(&mut Bundle) -> T) -> T {
        BUNDLES.with(|bundles| {
            let mut bundles = bundles.borrow_mut();
            let bundle = bundles.entry(self).or_insert_with(|| {
                let locale = self.tag().parse().expect("a shipped locale tag is valid");
                let mut bundle = Bundle::new(vec![locale]);
                let resource = FluentResource::try_new(self.source().to_owned()).unwrap_or_else(
                    |(_, errors)| panic!("invalid {} Fluent resource: {errors:?}", self.tag()),
                );
                bundle.add_resource(resource).unwrap_or_else(|error| {
                    panic!("duplicate {} Fluent message: {error:?}", self.tag())
                });
                bundle
            });
            operation(bundle)
        })
    }

    pub(crate) fn text(self, id: MessageId) -> String {
        self.render(id, &[])
    }

    /// Formats a key produced by the native error bridge. The key is still
    /// checked against the generated enum before it reaches the catalog.
    pub(crate) fn text_key(self, key: &str) -> String {
        let id = MessageId::from_legacy_key(key)
            .expect("native error message key is present in generated bindings");
        self.text(id)
    }

    /// User supplied values enter Fluent only as arguments, never as message
    /// syntax. This keeps braces in names and paths as ordinary text.
    pub(crate) fn render(self, id: MessageId, values: &[(&str, &str)]) -> String {
        self.with_bundle(|bundle| {
            let message = bundle
                .get_message(id.as_str())
                .expect("generated message id exists in every validated catalogue");
            let pattern = message
                .value()
                .expect("native Fluent messages have a value");
            let mut args = FluentArgs::new();
            for (name, value) in values {
                args.set(*name, *value);
            }
            let mut errors = Vec::new();
            bundle
                .format_pattern(pattern, Some(&args), &mut errors)
                .into_owned()
        })
    }

    fn render_count(self, id: MessageId, count: usize) -> String {
        self.with_bundle(|bundle| {
            let message = bundle
                .get_message(id.as_str())
                .expect("generated message id exists in every validated catalogue");
            let pattern = message
                .value()
                .expect("native Fluent messages have a value");
            let mut args = FluentArgs::new();
            args.set("count", count as f64);
            let mut errors = Vec::new();
            bundle
                .format_pattern(pattern, Some(&args), &mut errors)
                .into_owned()
        })
    }

    pub(crate) fn documents(self, count: usize) -> String {
        self.render_count(MessageId::InterfaceCountDocuments, count)
    }

    /// The reset guard accepts only this locale's exact phrase, with canonical
    /// NFC/NFD equivalence. It performs no case, compatibility, or space folding.
    pub(crate) fn reset_phrase_matches(self, typed: &str) -> bool {
        let phrase = self.text(MessageId::NativeResetPhrase);
        let max_bytes: usize = phrase.nfd().map(char::len_utf8).sum();
        typed.len() <= max_bytes && typed.nfc().eq(phrase.nfc())
    }
}

type Bundle = FluentBundle<FluentResource>;

thread_local! {
    static BUNDLES: RefCell<HashMap<UiLocale, Bundle>> = RefCell::new(HashMap::new());
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn native_locales_are_validated_and_the_same_resources_format_native_copy() {
        for locale in UiLocale::ALL {
            assert!(
                serde_json::from_value::<UiLocale>(Value::String(locale.tag().to_owned())).is_ok()
            );
            let text = locale.render(
                MessageId::NativeSetAsideDesktop,
                &[("folder", "/FAKE/{kept}/é")],
            );
            assert!(text.contains("/FAKE/{kept}/é"));
            assert!(!text.contains("{folder}"));
        }
        for value in [
            Value::String("de".to_owned()),
            Value::String("{kept}".to_owned()),
            Value::Bool(true),
            Value::Null,
        ] {
            assert!(serde_json::from_value::<UiLocale>(value).is_err());
        }
    }

    #[test]
    fn native_plural_formatting_uses_fluent_locale_rules_and_number_formatting() {
        assert_eq!(UiLocale::Pl.documents(1), "1 dokument");
        assert_eq!(UiLocale::Pl.documents(2), "2 dokumenty");
        assert_eq!(UiLocale::Pl.documents(5), "5 dokumentów");
        assert_eq!(UiLocale::Pl.documents(12), "12 dokumentów");
        assert_eq!(UiLocale::Pl.documents(22), "22 dokumenty");
        assert_eq!(UiLocale::En.documents(12345), "12,345 documents");
        assert_eq!(UiLocale::Fr.documents(12345), "12\u{202f}345 documents");
        assert_eq!(UiLocale::Pl.documents(12345), "12\u{a0}345 dokumentów");
    }

    #[test]
    fn reset_guard_accepts_only_the_locale_phrase_and_canonical_accents() {
        for (index, locale) in UiLocale::ALL.iter().copied().enumerate() {
            let phrase = locale.text(MessageId::NativeResetPhrase);
            assert!(locale.reset_phrase_matches(&phrase));
            assert!(locale.reset_phrase_matches(&phrase.nfd().collect::<String>()));
            assert!(!locale.reset_phrase_matches(&phrase.to_lowercase()));
            assert!(!locale.reset_phrase_matches(&format!(" {phrase}")));
            assert!(!locale.reset_phrase_matches(&format!("{phrase} ")));
            assert!(!locale.reset_phrase_matches("FAKE"));
            assert!(!locale.reset_phrase_matches(
                &UiLocale::ALL[(index + 1) % UiLocale::ALL.len()]
                    .text(MessageId::NativeResetPhrase)
            ));
        }
        assert!(UiLocale::default().reset_phrase_matches("RESET MYCARLOS VAULT"));
        assert!(!UiLocale::En.reset_phrase_matches("ＲＥＳＥＴ ＭＹＣＡＲＬＯＳ ＶＡＵＬＴ"));
    }
}
