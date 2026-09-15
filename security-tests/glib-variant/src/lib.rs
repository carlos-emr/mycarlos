#[cfg(test)]
mod tests {
    use glib::prelude::*;

    fn strings() -> glib::Variant {
        ["first", "middle", "last"].to_variant()
    }

    #[test]
    fn next_reads_strings_without_null_dereferences() {
        let variant = strings();
        let mut iter = variant.array_iter_str().unwrap();
        assert_eq!(iter.next(), Some("first"));
        assert_eq!(iter.next(), Some("middle"));
        assert_eq!(iter.next(), Some("last"));
        assert_eq!(iter.next(), None);
    }

    #[test]
    fn next_back_reads_strings_without_null_dereferences() {
        let variant = strings();
        let mut iter = variant.array_iter_str().unwrap();
        assert_eq!(iter.next_back(), Some("last"));
        assert_eq!(iter.next_back(), Some("middle"));
        assert_eq!(iter.next_back(), Some("first"));
        assert_eq!(iter.next_back(), None);
    }

    #[test]
    fn last_reads_the_final_string() {
        let variant = strings();
        assert_eq!(variant.array_iter_str().unwrap().last(), Some("last"));
    }

    #[test]
    fn nth_and_nth_back_read_selected_strings() {
        let variant = strings();
        assert_eq!(variant.array_iter_str().unwrap().nth(1), Some("middle"));
        assert_eq!(
            variant.array_iter_str().unwrap().nth_back(1),
            Some("middle")
        );
    }

    #[test]
    fn mixed_iteration_preserves_empty_and_unicode_strings() {
        let variant = ["", "résultat", "文件"].to_variant();
        let mut iter = variant.array_iter_str().unwrap();
        assert_eq!(iter.next(), Some(""));
        assert_eq!(iter.next_back(), Some("文件"));
        assert_eq!(iter.next(), Some("résultat"));
        assert_eq!(iter.len(), 0);
        assert_eq!(iter.next_back(), None);
        assert_eq!(iter.next(), None);
    }
}
