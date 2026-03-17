import SwiftUI

struct EmptyStateView: View {
    var onSuggestion: ((String) -> Void)?
    @Environment(\.colorScheme) private var colorScheme

    private let suggestions = [
        SuggestionItem(icon: "lightbulb", text: "Explain quantum computing simply"),
        SuggestionItem(icon: "pencil.and.outline", text: "Write a professional email"),
        SuggestionItem(icon: "terminal", text: "Help me debug my code"),
        SuggestionItem(icon: "translate", text: "Translate this text to Chinese"),
    ]

    var body: some View {
        VStack(spacing: 28) {
            // Logo
            LumiChatLogo(size: 48)

            Text("What can I help with?")
                .font(LCFont.semibold(22))
                .foregroundStyle(.primary)

            // Suggestion chips
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                ForEach(suggestions) { s in
                    Button {
                        Haptics.tap()
                        onSuggestion?(s.text)
                    } label: {
                        HStack(spacing: 8) {
                            Image(systemName: s.icon)
                                .font(.system(size: 14))
                                .foregroundStyle(LCColor.accent)
                                .frame(width: 20)
                            Text(s.text)
                                .font(LCFont.body(13))
                                .foregroundStyle(.primary)
                                .lineLimit(2)
                                .multilineTextAlignment(.leading)
                            Spacer()
                        }
                        .padding(12)
                        .background(colorScheme == .dark ? Color.white.opacity(0.05) : Color.black.opacity(0.03))
                        .clipShape(RoundedRectangle(cornerRadius: LCRadius.r2))
                        .overlay(
                            RoundedRectangle(cornerRadius: LCRadius.r2)
                                .stroke(colorScheme == .dark ? Color.white.opacity(0.08) : Color.black.opacity(0.06), lineWidth: 1)
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 8)
        }
        .frame(maxWidth: 440)
        .padding(.horizontal, 24)
    }
}

private struct SuggestionItem: Identifiable {
    let id = UUID()
    let icon: String
    let text: String
}
