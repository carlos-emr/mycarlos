//! The folders every new vault starts with (#66), so that a patient can file
//! their first documents without making folders by hand.
//!
//! PLACEHOLDER: the real set (names, order and any sub-folders) comes from
//! Dr. Chen's designs, which have not arrived. The list below only proves the
//! mechanism, and its names say so; replace [`PLACEHOLDER_SET`] when the
//! designs land. It is the one place the set is kept.
//!
//! Vault::create writes the set in the same save that creates the vault, so
//! no vault ever has part of it. After that they are ordinary folders: the
//! patient can rename, move, nest or delete them, nothing files itself into
//! them, and an existing vault never gets them.

/// One folder of the starting set, with the folders it holds.
#[derive(Debug)]
pub struct DefaultFolder {
    /// Passes the same name checks as a folder the patient makes.
    pub name: &'static str,
    pub children: &'static [DefaultFolder],
}

/// PLACEHOLDER until the designs arrive (see the module comment). One
/// sub-folder is here only so that nesting is exercised.
pub const PLACEHOLDER_SET: &[DefaultFolder] = &[
    DefaultFolder {
        name: "Visits (placeholder)",
        children: &[],
    },
    DefaultFolder {
        name: "Test results (placeholder)",
        children: &[DefaultFolder {
            name: "Imaging (placeholder)",
            children: &[],
        }],
    },
    DefaultFolder {
        name: "Medications (placeholder)",
        children: &[],
    },
    DefaultFolder {
        name: "Letters and forms (placeholder)",
        children: &[],
    },
];

/// The starting set, named in `language`: the app's language when the vault
/// is created (#46). The names are the patient's own from then on and do not
/// follow a later change of language.
///
/// Hook for #46: the app has one language today, so every language gets the
/// English placeholder set. Once #46 lands, the front end sends its current
/// language with `vault_create`, and this returns that language's names,
/// falling back to English for one it does not have.
pub fn for_language(_language: Option<&str>) -> &'static [DefaultFolder] {
    PLACEHOLDER_SET
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(set: &[DefaultFolder]) -> Vec<&'static str> {
        set.iter()
            .flat_map(|folder| std::iter::once(folder.name).chain(names(folder.children)))
            .collect()
    }

    #[test]
    fn says_it_is_a_placeholder_until_the_designs_arrive() {
        // A reminder that cannot be missed: drop this test with the placeholder.
        assert!(names(PLACEHOLDER_SET)
            .iter()
            .all(|name| name.ends_with(" (placeholder)")));
    }

    #[test]
    fn gives_every_language_a_set_for_now() {
        for language in [None, Some("en"), Some("fr"), Some("not-a-language")] {
            assert_eq!(names(for_language(language)), names(PLACEHOLDER_SET));
        }
    }
}
