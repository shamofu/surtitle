//! Searchable common language names; arbitrary existing codes remain valid input.
pub(super) const LANGUAGES: &[(&str, &str, &str)] = &[
    ("en", "英語", "English"),
    ("ja", "日本語", "Japanese"),
    ("es", "スペイン語", "Spanish"),
    ("fr", "フランス語", "French"),
    ("de", "ドイツ語", "German"),
    ("ko", "韓国語", "Korean"),
    ("zh", "中国語", "Chinese"),
    ("it", "イタリア語", "Italian"),
    ("pt", "ポルトガル語", "Portuguese"),
    ("ru", "ロシア語", "Russian"),
    ("ar", "アラビア語", "Arabic"),
    ("hi", "ヒンディー語", "Hindi"),
    ("vi", "ベトナム語", "Vietnamese"),
    ("th", "タイ語", "Thai"),
    ("id", "インドネシア語", "Indonesian"),
    ("nl", "オランダ語", "Dutch"),
    ("sv", "スウェーデン語", "Swedish"),
    ("pl", "ポーランド語", "Polish"),
    ("tr", "トルコ語", "Turkish"),
    ("uk", "ウクライナ語", "Ukrainian"),
];
pub(super) fn resolve(raw: &str) -> String {
    LANGUAGES
        .iter()
        .find(|(code, ja, en)| {
            [code, ja, en]
                .into_iter()
                .any(|value| value.eq_ignore_ascii_case(raw.trim()))
        })
        .map(|(code, _, _)| (*code).to_owned())
        .unwrap_or_else(|| raw.trim().to_owned())
}
pub(super) fn matches(raw: &str) -> Vec<(&'static str, &'static str, &'static str)> {
    let query = raw.trim().to_lowercase();
    LANGUAGES
        .iter()
        .copied()
        .filter(|(code, ja, en)| {
            query.is_empty()
                || code.contains(&query)
                || ja.contains(&query)
                || en.to_lowercase().contains(&query)
        })
        .take(5)
        .collect()
}
