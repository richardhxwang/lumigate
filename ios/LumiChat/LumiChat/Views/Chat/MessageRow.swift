import SwiftUI

struct MessageRow: View {
    let message: ChatMessage
    var onDelete: (() -> Void)?
    var onEdit: ((String) -> Void)?
    var onResend: (() -> Void)?
    @State private var isEditing = false
    @State private var editText = ""
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        if message.role == "user" {
            userRow
        } else {
            assistantRow
        }
    }

    // MARK: - User Message

    private var userRow: some View {
        HStack {
            Spacer(minLength: 80)

            if isEditing {
                // Inline edit
                VStack(alignment: .trailing, spacing: 6) {
                    TextField("Edit message", text: $editText, axis: .vertical)
                        .font(LCFont.body(15))
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background(colors.userBg)
                        .clipShape(RoundedRectangle(cornerRadius: LCRadius.r4))
                        .lineLimit(1...12)

                    HStack(spacing: 8) {
                        Button("Cancel") {
                            isEditing = false
                        }
                        .font(LCFont.body(13))
                        .foregroundStyle(.secondary)

                        Button("Save & Resend") {
                            let newText = editText.trimmingCharacters(in: .whitespacesAndNewlines)
                            if !newText.isEmpty {
                                onEdit?(newText)
                            }
                            isEditing = false
                        }
                        .font(LCFont.medium(13))
                        .foregroundStyle(LCColor.accent)
                    }
                }
            } else {
                Text(message.content)
                    .font(LCFont.body(15))
                    .foregroundStyle(colors.t1)
                    .padding(.horizontal, 18)
                    .padding(.vertical, 12)
                    .background(colors.userBg)
                    .clipShape(RoundedRectangle(cornerRadius: LCRadius.r4))
                    .contextMenu {
                        Button("Copy", systemImage: "doc.on.doc") {
                            UIPasteboard.general.string = message.content
                            Haptics.tap()
                        }
                        Button("Edit", systemImage: "pencil") {
                            editText = message.content
                            isEditing = true
                        }
                        if let onResend {
                            Button("Resend", systemImage: "arrow.clockwise") { onResend() }
                        }
                        if let onDelete {
                            Button("Delete", systemImage: "trash", role: .destructive) { onDelete() }
                        }
                    }
            }
        }
        .padding(.horizontal, 24)
        .padding(.top, 20)
    }

    // MARK: - Assistant Message

    private var assistantRow: some View {
        VStack(alignment: .leading, spacing: 0) {
            RichMarkdownView(text: message.content)
                .contextMenu {
                    Button("Copy", systemImage: "doc.on.doc") {
                        UIPasteboard.general.string = message.content
                        Haptics.tap()
                    }
                    if let onDelete {
                        Button("Delete", systemImage: "trash", role: .destructive) { onDelete() }
                    }
                }

            // Inline copy button for assistant messages
            HStack(spacing: 12) {
                CopyButton(text: message.content)
            }
            .padding(.top, 8)
        }
        .frame(maxWidth: LCLayout.maxChatWidth, alignment: .leading)
        .padding(.horizontal, 24)
        .padding(.top, 20)
    }

    private var colors: LCColors { LCColors(colorScheme: colorScheme) }
}

// MARK: - Streaming Message (during SSE)

struct StreamingMessageRow: View {
    let text: String

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(text)
                .font(LCFont.body(15))
                .lineSpacing(6)
                .textSelection(.enabled)
        }
        .frame(maxWidth: LCLayout.maxChatWidth, alignment: .leading)
        .padding(.horizontal, 24)
        .padding(.top, 20)
    }
}

// MARK: - Copy Button

struct CopyButton: View {
    let text: String
    @State private var copied = false

    var body: some View {
        Button {
            UIPasteboard.general.string = text
            Haptics.tap()
            copied = true
            Task {
                try? await Task.sleep(for: .seconds(2))
                copied = false
            }
        } label: {
            Image(systemName: copied ? "checkmark" : "doc.on.doc")
                .font(.system(size: 13))
                .foregroundStyle(copied ? LCColor.accent : .secondary)
        }
        .buttonStyle(.plain)
        .animation(.easeInOut(duration: 0.2), value: copied)
    }
}

// MARK: - Search Indicator

struct SearchIndicator: View {
    let query: String

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 14))
            Text("Searching: ")
                .font(LCFont.body(13)) +
            Text(query)
                .font(LCFont.body(13))
                .italic()
        }
        .foregroundStyle(.secondary)
    }
}
