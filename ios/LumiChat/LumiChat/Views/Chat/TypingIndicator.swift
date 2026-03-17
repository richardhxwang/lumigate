import SwiftUI

struct TypingIndicator: View {
    let isThinking: Bool

    @State private var dotAnimations = [false, false, false]

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            // Three dots
            HStack(spacing: 5) {
                ForEach(0..<3, id: \.self) { i in
                    Circle()
                        .fill(Color.secondary)
                        .frame(width: 7, height: 7)
                        .offset(y: dotAnimations[i] ? -3 : 0)
                        .opacity(dotAnimations[i] ? 1 : 0.3)
                }
            }

            // "Thinking" label for reasoning models
            if isThinking {
                Text("Thinking")
                    .font(LCFont.body(12))
                    .foregroundStyle(.tertiary)
                    .opacity(0.7)
            }
        }
        .onAppear { startAnimation() }
        .onDisappear { dotAnimations = [false, false, false] }
    }

    private func startAnimation() {
        for i in 0..<3 {
            Timer.scheduledTimer(withTimeInterval: Double(i) * 0.2, repeats: false) { _ in
                withAnimation(.easeInOut(duration: 0.4).repeatForever(autoreverses: true)) {
                    dotAnimations[i] = true
                }
            }
        }
    }
}
