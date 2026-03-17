import SwiftUI

/// Renders markdown with code blocks that have copy buttons and syntax labels
struct RichMarkdownView: View {
    let text: String
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(parseBlocks().enumerated()), id: \.offset) { _, block in
                switch block {
                case .text(let content):
                    if let attr = try? AttributedString(
                        markdown: content,
                        options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
                    ) {
                        Text(attr)
                            .font(LCFont.body(15))
                            .lineSpacing(6)
                            .textSelection(.enabled)
                            .tint(Color(hex: "#6ea8fe"))
                    } else {
                        Text(content)
                            .font(LCFont.body(15))
                            .lineSpacing(6)
                            .textSelection(.enabled)
                    }

                case .code(let lang, let code):
                    CodeBlockView(language: lang, code: code)
                        .padding(.vertical, 8)
                }
            }
        }
    }

    // MARK: - Parse into text/code blocks

    private enum Block {
        case text(String)
        case code(lang: String, code: String)
    }

    private func parseBlocks() -> [Block] {
        var blocks: [Block] = []
        var remaining = text[text.startIndex...]
        let fence = "```"

        while let fenceStart = remaining.range(of: fence) {
            // Text before fence
            let before = String(remaining[remaining.startIndex..<fenceStart.lowerBound])
            if !before.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                blocks.append(.text(before))
            }

            // After opening fence
            let afterFence = remaining[fenceStart.upperBound...]

            // Get language (rest of first line)
            var lang = ""
            if let newline = afterFence.firstIndex(of: "\n") {
                lang = String(afterFence[afterFence.startIndex..<newline]).trimmingCharacters(in: .whitespaces)
                remaining = afterFence[afterFence.index(after: newline)...]
            } else {
                remaining = afterFence
            }

            // Find closing fence
            if let closeRange = remaining.range(of: fence) {
                let code = String(remaining[remaining.startIndex..<closeRange.lowerBound])
                    .trimmingCharacters(in: CharacterSet(charactersIn: "\n"))
                blocks.append(.code(lang: lang, code: code))
                remaining = remaining[closeRange.upperBound...]
            } else {
                // No closing fence — treat rest as code
                let code = String(remaining).trimmingCharacters(in: CharacterSet(charactersIn: "\n"))
                blocks.append(.code(lang: lang, code: code))
                remaining = remaining[remaining.endIndex...]
            }
        }

        // Remaining text
        let tail = String(remaining)
        if !tail.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            blocks.append(.text(tail))
        }

        return blocks
    }
}

// MARK: - Code Block

struct CodeBlockView: View {
    let language: String
    let code: String
    @State private var copied = false
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Header: language + copy button
            HStack {
                Text(language.isEmpty ? "code" : language)
                    .font(LCFont.mono(11))
                    .foregroundStyle(.secondary)

                Spacer()

                Button {
                    UIPasteboard.general.string = code
                    Haptics.tap()
                    copied = true
                    Task {
                        try? await Task.sleep(for: .seconds(2))
                        copied = false
                    }
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: copied ? "checkmark" : "doc.on.doc")
                            .font(.system(size: 11))
                        Text(copied ? "Copied" : "Copy")
                            .font(LCFont.mono(11))
                    }
                    .foregroundStyle(copied ? LCColor.accent : .secondary)
                }
                .buttonStyle(.plain)
                .animation(.easeInOut(duration: 0.2), value: copied)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            .background(headerBg)

            // Code content
            ScrollView(.horizontal, showsIndicators: false) {
                Text(code)
                    .font(LCFont.mono(13))
                    .lineSpacing(4)
                    .textSelection(.enabled)
                    .padding(14)
            }
        }
        .background(codeBg)
        .clipShape(RoundedRectangle(cornerRadius: LCRadius.r2))
        .overlay(
            RoundedRectangle(cornerRadius: LCRadius.r2)
                .stroke(borderColor, lineWidth: 1)
        )
    }

    private var codeBg: Color {
        colorScheme == .dark ? LCColor.Dark.codeBg : LCColor.Light.codeBg
    }
    private var headerBg: Color {
        colorScheme == .dark ? Color.white.opacity(0.04) : Color.black.opacity(0.03)
    }
    private var borderColor: Color {
        colorScheme == .dark ? Color.white.opacity(0.08) : Color.black.opacity(0.08)
    }
}
