import SwiftUI

struct ChatHeaderBar: View {
    let chatVM: ChatViewModel
    var activeProject: Project?
    let onModelTap: () -> Void
    let onProjectTap: () -> Void
    var onMenuTap: (() -> Void)?
    var onNewChat: (() -> Void)?

    var body: some View {
        HStack(spacing: 10) {
            // Sidebar toggle
            Button {
                Haptics.tap()
                onMenuTap?()
            } label: {
                Image(systemName: "line.3.horizontal")
                    .font(.system(size: 18, weight: .medium))
                    .foregroundStyle(.primary)
                    .frame(width: 36, height: 36)
            }

            // Model selector
            Button(action: onModelTap) {
                HStack(spacing: 4) {
                    Text(ModelFormatter.format(chatVM.selectedModel))
                        .font(LCFont.semibold(15))
                    Image(systemName: "chevron.down")
                        .font(.system(size: 11, weight: .medium))
                        .foregroundStyle(.secondary)
                }
            }
            .buttonStyle(.plain)

            // Active project pill
            if let proj = activeProject {
                Button(action: onProjectTap) {
                    HStack(spacing: 4) {
                        Circle()
                            .fill(Color(hex: proj.color))
                            .frame(width: 8, height: 8)
                        Text(proj.name)
                            .font(LCFont.body(12))
                            .lineLimit(1)
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(Color(hex: proj.color).opacity(0.1))
                    .clipShape(Capsule())
                }
                .buttonStyle(.plain)
            }

            Spacer()

            // Status indicators
            HStack(spacing: 8) {
                if chatVM.webSearchEnabled {
                    Image(systemName: "globe")
                        .font(.system(size: 14))
                        .foregroundStyle(LCColor.accent)
                }

                if let usage = chatVM.usageInfo {
                    Text("\(usage.input + usage.output) tok")
                        .font(LCFont.mono(10))
                        .foregroundStyle(.tertiary)
                }
            }

            // New chat button
            Button {
                Haptics.tap()
                onNewChat?()
            } label: {
                Image(systemName: "square.and.pencil")
                    .font(.system(size: 17, weight: .medium))
                    .foregroundStyle(.primary)
                    .frame(width: 36, height: 36)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(.bar)
    }
}
