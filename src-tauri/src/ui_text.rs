//! Shared, fallible native Fluent formatting. Native consent never uses renderer text.
use crate::ui_text_ids::MessageId;
use fluent_bundle::{FluentArgs, FluentBundle, FluentResource, FluentValue};
use serde::Deserialize;
use std::cell::RefCell;
use std::collections::{hash_map::Entry, HashMap};
use unicode_normalization::UnicodeNormalization;
use zeroize::Zeroizing;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum UiTextError {
    InvalidCatalogue,
    MissingMessage,
    Formatting,
}

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

/// Whether a name is "Shared with me" as any language shows it, ignoring case,
/// space around it and how its accents are typed. The folder is shown in the
/// app's language, so a person by any of these names would read as it (#61).
/// A language whose name cannot be read refuses the name rather than let it
/// through.
pub(crate) fn names_shared_folder(name: &str) -> bool {
    let key = |text: &str| text.trim().nfc().collect::<String>().to_lowercase();
    let typed = key(name);
    UiLocale::ALL.iter().any(|locale| {
        match locale.text(MessageId::InterfaceLibrarySidebarSharedWithMe) {
            Ok(shown) => key(&shown) == typed,
            Err(_) => true,
        }
    })
}

impl UiLocale {
    /// Every shipped language, for checks that must hold in all of them.
    pub(crate) const ALL: [Self; 7] = [
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

    fn with_bundle<T>(
        self,
        operation: impl FnOnce(&mut Bundle) -> Result<T, UiTextError>,
    ) -> Result<T, UiTextError> {
        BUNDLES.with(|bundles| {
            let mut bundles = bundles
                .try_borrow_mut()
                .map_err(|_| UiTextError::Formatting)?;
            let bundle = match bundles.entry(self) {
                Entry::Occupied(entry) => entry.into_mut(),
                Entry::Vacant(entry) => entry.insert(bundle_from_source(self, self.source())?),
            };
            operation(bundle)
        })
    }

    pub(crate) fn text(self, id: MessageId) -> Result<String, UiTextError> {
        self.render(id, &[])
    }

    pub(crate) fn text_key(self, key: &str) -> Result<String, UiTextError> {
        self.text(MessageId::from_legacy_key(key).ok_or(UiTextError::MissingMessage)?)
    }

    pub(crate) fn render(
        self,
        id: MessageId,
        values: &[(&str, &str)],
    ) -> Result<String, UiTextError> {
        self.format_strings(id, values, true)
    }

    /// Recovery-key/label/date machine-value lines must contain the exact input bytes.
    pub(crate) fn render_raw(
        self,
        id: MessageId,
        values: &[(&str, &str)],
    ) -> Result<String, UiTextError> {
        self.format_strings(id, values, false)
    }

    fn format_strings(
        self,
        id: MessageId,
        values: &[(&str, &str)],
        isolating: bool,
    ) -> Result<String, UiTextError> {
        self.with_bundle(|bundle| {
            bundle.set_use_isolating(isolating);
            let message = bundle
                .get_message(id.as_str())
                .ok_or(UiTextError::MissingMessage)?;
            let pattern = message.value().ok_or(UiTextError::MissingMessage)?;
            let mut args = FluentArgs::new();
            for (name, value) in values {
                args.set(*name, *value);
            }
            let mut errors = Vec::new();
            let mut text = WipingText::with_capacity(
                values.iter().map(|(_, value)| value.len()).sum::<usize>() + 256,
            );
            bundle
                .write_pattern(&mut text, pattern, Some(&args), &mut errors)
                .map_err(|_| UiTextError::Formatting)?;
            if errors.is_empty() {
                Ok(text.into_string())
            } else {
                Err(UiTextError::Formatting)
            }
        })
    }

    pub(crate) fn documents(self, count: usize) -> Result<String, UiTextError> {
        self.with_bundle(|bundle| {
            bundle.set_use_isolating(true);
            let message = bundle
                .get_message(MessageId::InterfaceCountDocuments.as_str())
                .ok_or(UiTextError::MissingMessage)?;
            let pattern = message.value().ok_or(UiTextError::MissingMessage)?;
            let mut args = FluentArgs::new();
            args.set("count", count as f64);
            let mut errors = Vec::new();
            let text = bundle
                .format_pattern(pattern, Some(&args), &mut errors)
                .into_owned();
            if errors.is_empty() {
                Ok(text)
            } else {
                Err(UiTextError::Formatting)
            }
        })
    }

    pub(crate) fn reset_phrase_matches(self, typed: &str) -> Result<bool, UiTextError> {
        let phrase = self.text(MessageId::NativeResetPhrase)?;
        let max_bytes: usize = phrase.nfd().map(char::len_utf8).sum();
        Ok(typed.len() <= max_bytes && typed.nfc().eq(phrase.nfc()))
    }
}

/// Text built in one buffer that leaves no freed copy of itself behind: when it
/// must grow, the old buffer is wiped before it is freed. Values such as a
/// recovery key are copied in here, so no unwiped copy of one stays in freed
/// memory (#119).
struct WipingText(Zeroizing<String>);

impl WipingText {
    fn with_capacity(bytes: usize) -> Self {
        Self(Zeroizing::new(String::with_capacity(bytes)))
    }

    /// The text, in the buffer it was built in: nothing is copied.
    fn into_string(mut self) -> String {
        std::mem::take(&mut *self.0)
    }
}

impl std::fmt::Write for WipingText {
    fn write_str(&mut self, text: &str) -> std::fmt::Result {
        let needed = self.0.len() + text.len();
        if needed > self.0.capacity() {
            let mut grown = String::with_capacity(needed.max(self.0.capacity() * 2));
            grown.push_str(&self.0);
            // The old buffer is a Zeroizing: replacing it wipes it.
            self.0 = Zeroizing::new(grown);
        }
        self.0.push_str(text);
        Ok(())
    }
}

type Bundle = FluentBundle<FluentResource>;
fn bundle_from_source(locale: UiLocale, source: &str) -> Result<Bundle, UiTextError> {
    let language = locale
        .tag()
        .parse()
        .map_err(|_| UiTextError::InvalidCatalogue)?;
    let resource =
        FluentResource::try_new(source.to_owned()).map_err(|_| UiTextError::InvalidCatalogue)?;
    let mut bundle = Bundle::new(vec![language]);
    bundle
        .add_resource(resource)
        .map_err(|_| UiTextError::InvalidCatalogue)?;
    // Fluent selects plural forms from the numeric value; rendering keeps the
    // established native count grouping used by the installed interface.
    match locale {
        UiLocale::En | UiLocale::ZhCn | UiLocale::ZhTw => {
            bundle.set_formatter(Some(|value, _| grouped_integer(value, ",", false)))
        }
        UiLocale::Fr => {
            bundle.set_formatter(Some(|value, _| grouped_integer(value, "\u{202f}", false)))
        }
        UiLocale::Pl => {
            bundle.set_formatter(Some(|value, _| grouped_integer(value, "\u{a0}", true)))
        }
        UiLocale::Es => bundle.set_formatter(Some(|value, _| grouped_integer(value, ".", true))),
        UiLocale::PtBr => bundle.set_formatter(Some(|value, _| grouped_integer(value, ".", false))),
    }
    for id in MessageId::ALL {
        if bundle
            .get_message(id.as_str())
            .and_then(|m| m.value())
            .is_none()
        {
            return Err(UiTextError::MissingMessage);
        }
    }
    Ok(bundle)
}
thread_local! { static BUNDLES: RefCell<HashMap<UiLocale, Bundle>> = RefCell::new(HashMap::new()); }

fn grouped_integer(
    value: &FluentValue<'_>,
    separator: &str,
    skip_four_digits: bool,
) -> Option<String> {
    let FluentValue::Number(number) = value else {
        return None;
    };
    if !number.value.is_finite() || number.value < 0.0 || number.value.fract() != 0.0 {
        return None;
    }
    let digits = format!("{:.0}", number.value);
    if skip_four_digits && digits.len() <= 4 {
        return Some(digits);
    }
    let mut result = String::new();
    for (index, digit) in digits.chars().enumerate() {
        if index > 0 && (digits.len() - index).is_multiple_of(3) {
            result.push_str(separator);
        }
        result.push(digit);
    }
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn visible(text: String) -> String {
        text.replace(['\u{2068}', '\u{2069}'], "")
    }

    #[test]
    fn text_outgrowing_its_buffer_moves_to_a_new_one_with_nothing_lost() {
        use std::fmt::Write;
        let key = "FAKE-RECOVERY-WORDS-THAT-ARE-LONGER-THAN-THEIR-BUFFER";
        let mut text = WipingText::with_capacity(4);
        let first = text.0.as_ptr();
        write!(text, "Key: {key}, again {key}.").unwrap();
        // A new buffer was taken (the old one was wiped as it went).
        assert_ne!(text.0.as_ptr(), first);
        let grown = text.0.as_ptr();
        let written = text.into_string();
        assert_eq!(written, format!("Key: {key}, again {key}."));
        // Handed over in the same buffer, not copied out.
        assert_eq!(written.as_ptr(), grown);
    }
    #[test]
    fn recovery_kit_text_is_the_same_as_fluent_formats_it() {
        let key = "FAKE-RECOVERY-WORDS-THAT-ARE-MUCH-LONGER-THAN-A-PLACEHOLDER".repeat(8);
        let values = [
            ("key", key.as_str()),
            ("label", "FAKE label"),
            ("date", "2026-10-28"),
        ];
        for locale in UiLocale::ALL {
            for isolating in [false, true] {
                let ours = locale
                    .format_strings(MessageId::NativeKitText, &values, isolating)
                    .unwrap();
                let mut bundle = bundle_from_source(locale, locale.source()).unwrap();
                bundle.set_use_isolating(isolating);
                let pattern = bundle
                    .get_message(MessageId::NativeKitText.as_str())
                    .and_then(|message| message.value())
                    .unwrap();
                let mut args = FluentArgs::new();
                for (name, value) in values {
                    args.set(name, value);
                }
                let mut errors = Vec::new();
                let fluent = bundle.format_pattern(pattern, Some(&args), &mut errors);
                assert!(errors.is_empty());
                assert_eq!(ours, fluent, "{locale:?}");
            }
        }
    }
    #[test]
    fn the_shared_folder_name_is_refused_in_every_shipped_language() {
        for locale in UiLocale::ALL {
            let shown = locale
                .text(MessageId::InterfaceLibrarySidebarSharedWithMe)
                .unwrap();
            assert!(names_shared_folder(&shown), "{locale:?}");
            assert!(
                names_shared_folder(&format!("  {}  ", shown.to_uppercase())),
                "{locale:?}"
            );
            assert!(!names_shared_folder(&format!("{shown} 2")), "{locale:?}");
        }
    }

    #[test]
    fn all_seven_resources_parse_and_format_untrusted_arguments_as_text() {
        for locale in UiLocale::ALL {
            bundle_from_source(locale, locale.source()).unwrap();
            let value = "/FAKE/{kept}/<tag>/مرحبا";
            let text = locale
                .render(MessageId::NativeSetAsideDesktop, &[("folder", value)])
                .unwrap();
            assert!(text.contains(value));
            assert!(text.contains('\u{2068}'));
        }
    }
    #[test]
    fn every_native_message_formats_in_each_locale_without_resolver_errors() {
        let values = [
            ("key", "FAKE-KEY"),
            ("label", "BEAD"),
            ("date", "2026-10-27"),
            ("documents", "FAKE documents"),
            ("kept", "FAKE kept"),
            ("removal", "FAKE removal"),
            ("folder", "/FAKE/{folder}/אבג"),
        ];
        for locale in UiLocale::ALL {
            for id in MessageId::ALL {
                if id.as_str().starts_with("native-") {
                    let result = locale.render(*id, &values);
                    assert!(result.is_ok(), "{locale:?}/{id:?}: {result:?}");
                    assert!(!result.unwrap().trim().is_empty());
                }
            }
        }
    }
    #[test]
    fn malformed_duplicate_missing_and_incomplete_arguments_fail_recoverably() {
        assert!(matches!(
            bundle_from_source(UiLocale::En, "broken = {"),
            Err(UiTextError::InvalidCatalogue)
        ));
        assert!(matches!(
            bundle_from_source(UiLocale::En, "only = One"),
            Err(UiTextError::MissingMessage)
        ));
        assert!(matches!(
            bundle_from_source(
                UiLocale::En,
                &(UiLocale::En.source().to_owned() + "\nnative-cancel = Again\n")
            ),
            Err(UiTextError::InvalidCatalogue)
        ));
        assert_eq!(
            UiLocale::En.render(MessageId::NativeSetAsideDesktop, &[]),
            Err(UiTextError::Formatting)
        );
        assert_eq!(
            UiLocale::En.text_key("missing.key"),
            Err(UiTextError::MissingMessage)
        );
    }
    #[test]
    fn plural_selection_and_installed_native_count_grouping_are_retained() {
        for (n, expected) in [
            (1, "1 dokument"),
            (2, "2 dokumenty"),
            (5, "5 dokumentów"),
            (12, "12 dokumentów"),
            (22, "22 dokumenty"),
        ] {
            assert_eq!(visible(UiLocale::Pl.documents(n).unwrap()), expected);
        }
        for (locale, expected) in [
            (UiLocale::En, "12,345 documents"),
            (UiLocale::Fr, "12\u{202f}345 documents"),
            (UiLocale::Pl, "12\u{a0}345 dokumentów"),
        ] {
            assert_eq!(visible(locale.documents(12345).unwrap()), expected);
        }
        assert!(visible(UiLocale::ZhCn.documents(12345).unwrap()).contains("12,345"));
        assert!(visible(UiLocale::ZhTw.documents(12345).unwrap()).contains("12,345"));
    }
    #[test]
    fn reset_guards_accept_only_exact_locale_phrase_and_canonical_equivalence() {
        for locale in UiLocale::ALL {
            let phrase = locale.text(MessageId::NativeResetPhrase).unwrap();
            assert!(locale.reset_phrase_matches(&phrase).unwrap());
            assert!(locale
                .reset_phrase_matches(&phrase.nfd().collect::<String>())
                .unwrap());
            assert!(!locale.reset_phrase_matches(&phrase.to_lowercase()).unwrap());
            assert!(!locale.reset_phrase_matches(&format!(" {phrase}")).unwrap());
            assert!(!locale.reset_phrase_matches(&format!("{phrase} ")).unwrap());
            assert!(!locale.reset_phrase_matches("FAKE").unwrap());
        }
        assert!(!UiLocale::En
            .reset_phrase_matches("ＲＥＳＥＴ ＭＹＣＡＲＬＯＳ ＶＡＵＬＴ")
            .unwrap());
    }
    #[test]
    fn raw_recovery_output_preserves_tokens_without_bidi_marks_or_interpolation() {
        let key = "ABCD-EFGH-IJKL-MNOP-QRST-UVWX-YZ23";
        let label = "FAKE{key}";
        for locale in UiLocale::ALL {
            let text = locale
                .render_raw(
                    MessageId::NativeKitText,
                    &[("key", key), ("label", label), ("date", "2026-10-27")],
                )
                .unwrap();
            assert!(text.contains(key));
            assert!(text.contains(label));
            assert!(!text.chars().any(|c| matches!(c, '\u{2066}'..='\u{2069}')));
            assert_eq!(text.matches(key).count(), 1);
        }
    }
}
