import Foundation

enum ModelFormatter {
    /// Strip date suffixes: "gpt-4o-2024-11-20" → "GPT-4o"
    static func format(_ id: String) -> String {
        var s = id
        // Strip date suffix (e.g. -2024-11-20, -20250514)
        if let range = s.range(of: #"-\d{4}-?\d{2}-?\d{2}$"#, options: .regularExpression) {
            s = String(s[s.startIndex..<range.lowerBound])
        }
        // Friendly names
        let map: [(String, String)] = [
            ("gpt-4.1-nano", "GPT-4.1 Nano"),
            ("gpt-4.1-mini", "GPT-4.1 Mini"),
            ("gpt-4.1", "GPT-4.1"),
            ("gpt-4o-mini", "GPT-4o Mini"),
            ("gpt-4o", "GPT-4o"),
            ("gpt-4-turbo", "GPT-4 Turbo"),
            ("claude-opus-4-6", "Claude Opus 4.6"),
            ("claude-sonnet-4-6", "Claude Sonnet 4.6"),
            ("claude-haiku-4-5", "Claude Haiku 4.5"),
            ("gemini-2.5-flash", "Gemini 2.5 Flash"),
            ("gemini-2.5-pro", "Gemini 2.5 Pro"),
            ("gemini-2.0-flash", "Gemini 2.0 Flash"),
            ("deepseek-chat", "DeepSeek Chat"),
            ("deepseek-reasoner", "DeepSeek Reasoner"),
            ("MiniMax-M2.5", "MiniMax M2.5"),
            ("MiniMax-M2.1", "MiniMax M2.1"),
            ("MiniMax-M1", "MiniMax M1"),
        ]
        for (key, label) in map {
            if s.lowercased() == key.lowercased() { return label }
        }
        return s
    }
}
