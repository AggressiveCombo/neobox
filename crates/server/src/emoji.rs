//! Chat emoji shortcodes: `:fire:` becomes 🔥.
//!
//! The table is `emoji.tsv` (alias, TAB, emoji), generated from the gemoji
//! dataset by `tools/emoji/gen.mjs`. gemoji is MIT licensed, Copyright (c)
//! GitHub, Inc.; see CREDITS.md.

use std::collections::HashMap;
use std::sync::LazyLock;

const TABLE_TSV: &str = include_str!("emoji.tsv");

static TABLE: LazyLock<HashMap<&'static str, &'static str>> = LazyLock::new(|| {
    TABLE_TSV
        .lines()
        .filter(|line| !line.starts_with('#'))
        .filter_map(|line| line.split_once('\t'))
        .collect()
});

/// Shortcode name bytes: the characters gemoji aliases are made of.
fn is_name_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'_' | b'+' | b'-')
}

/// Replaces every `:name:` whose name is a known alias (case-insensitive) with
/// its emoji. Unknown names stay as typed. A colon directly after a letter or
/// digit does not open a shortcode, so URLs such as `https://host:8080/x` and
/// `host:fire:` are left alone.
pub fn replace_shortcodes(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    // Text before `copied` has already been written to `out`.
    let mut copied = 0;
    let mut i = 0;
    while let Some(off) = text[i..].find(':') {
        let open = i + off;
        // From here on the search resumes after the colon, so a colon that
        // closes an unknown name can still open the next shortcode.
        i = open + 1;
        if open > 0 && bytes[open - 1].is_ascii_alphanumeric() {
            continue;
        }
        let name_start = open + 1;
        let name_len = bytes[name_start..].iter().take_while(|&&b| is_name_byte(b)).count();
        let close = name_start + name_len;
        if name_len == 0 || bytes.get(close) != Some(&b':') {
            continue;
        }
        let name = text[name_start..close].to_ascii_lowercase();
        if let Some(emoji) = TABLE.get(name.as_str()) {
            out.push_str(&text[copied..open]);
            out.push_str(emoji);
            copied = close + 1;
            i = close + 1;
        }
    }
    out.push_str(&text[copied..]);
    out
}

#[cfg(test)]
mod tests {
    use super::replace_shortcodes;

    #[test]
    fn replaces_known_shortcode() {
        assert_eq!(replace_shortcodes(":fire:"), "🔥");
    }

    #[test]
    fn lookup_is_case_insensitive() {
        assert_eq!(replace_shortcodes("so :Smile:"), "so 😄");
        assert_eq!(replace_shortcodes(":FIRE:"), "🔥");
    }

    #[test]
    fn replaces_several_and_symbolic_names() {
        assert_eq!(replace_shortcodes(":fire::+1:"), "🔥👍");
        assert_eq!(replace_shortcodes(":-1: :100:"), "👎 💯");
    }

    #[test]
    fn unknown_names_stay_as_typed() {
        assert_eq!(replace_shortcodes(":notanemoji:"), ":notanemoji:");
        assert_eq!(replace_shortcodes(":notanemoji: :fire:"), ":notanemoji: 🔥");
        assert_eq!(replace_shortcodes(":nope:fire:"), ":nope:fire:");
    }

    #[test]
    fn keeps_surrounding_text() {
        assert_eq!(replace_shortcodes("gg :fire: ünïcode ✨ done"), "gg 🔥 ünïcode ✨ done");
        assert_eq!(replace_shortcodes("no codes here"), "no codes here");
        assert_eq!(replace_shortcodes(""), "");
        assert_eq!(replace_shortcodes("ratio: 3 : 1 :"), "ratio: 3 : 1 :");
    }

    #[test]
    fn adjacent_shortcodes_both_replace() {
        assert_eq!(replace_shortcodes(":fire::smile:"), "🔥😄");
    }

    #[test]
    fn urls_with_colons_are_untouched() {
        let url = "https://example.com:8080/a:fire:";
        assert_eq!(replace_shortcodes(url), url);
        assert_eq!(replace_shortcodes("see https://example.com:443/x"), "see https://example.com:443/x");
        assert_eq!(replace_shortcodes("http://youtu.be/dQw4w9WgXcQ:smile"), "http://youtu.be/dQw4w9WgXcQ:smile");
        assert_eq!(replace_shortcodes("https://x.y:100:"), "https://x.y:100:");
    }
}
