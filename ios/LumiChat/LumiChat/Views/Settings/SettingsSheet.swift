import SwiftUI

struct SettingsSheet: View {
    @Environment(AppState.self) private var appState
    @Environment(\.dismiss) private var dismiss
    @State private var vm = SettingsViewModel()

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                // User header
                HStack(spacing: 12) {
                    ZStack {
                        Circle().fill(LCColor.accent)
                        Text(String((appState.currentUser?.name ?? "?").prefix(1)).uppercased())
                            .font(LCFont.bold(18))
                            .foregroundStyle(.white)
                    }
                    .frame(width: 44, height: 44)

                    VStack(alignment: .leading, spacing: 1) {
                        Text(appState.currentUser?.name ?? "")
                            .font(LCFont.semibold(16))
                            .lineLimit(1)
                        Text(appState.currentUser?.email ?? "")
                            .font(LCFont.body(12))
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                    }
                    Spacer()
                }
                .padding(.horizontal, 24)
                .padding(.vertical, 16)

                Divider()

                // Tabs
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 2) {
                        ForEach(["chat", "presets", "appearance", "subscription", "account"], id: \.self) { tab in
                            Button {
                                vm.activeTab = tab
                            } label: {
                                Text(tab.capitalized)
                                    .font(LCFont.medium(13))
                                    .padding(.horizontal, 14)
                                    .padding(.vertical, 8)
                                    .foregroundStyle(vm.activeTab == tab ? LCColor.accent : .secondary)
                                    .overlay(alignment: .bottom) {
                                        if vm.activeTab == tab {
                                            Rectangle().fill(LCColor.accent).frame(height: 2)
                                        }
                                    }
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal, 16)
                }
                .padding(.top, 4)

                Divider()

                // Tab content
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        switch vm.activeTab {
                        case "chat": chatTab
                        case "presets": presetsTab
                        case "appearance": appearanceTab
                        case "subscription": subscriptionTab
                        case "account": accountTab
                        default: EmptyView()
                        }
                    }
                    .padding(24)
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .foregroundStyle(LCColor.accent)
                }
            }
        }
        .task { await vm.load() }
    }

    // MARK: - Chat Tab

    private var chatTab: some View {
        VStack(alignment: .leading, spacing: 16) {
            // Memory
            VStack(alignment: .leading, spacing: 6) {
                Text("GLOBAL MEMORY")
                    .font(LCFont.semibold(12))
                    .foregroundStyle(.tertiary)
                TextEditor(text: $vm.memory)
                    .font(LCFont.body(13.5))
                    .frame(minHeight: 80)
                    .padding(10)
                    .background(.quaternary.opacity(0.5))
                    .clipShape(RoundedRectangle(cornerRadius: LCRadius.r2))
                    .onChange(of: vm.memory) { _, _ in
                        Task { await vm.saveMemory() }
                    }
                Text("Prepended as system context to every conversation.")
                    .font(LCFont.body(12))
                    .foregroundStyle(.tertiary)
            }

            Divider()

            // Sensitivity
            VStack(alignment: .leading, spacing: 8) {
                Text("RESPONSE MODE")
                    .font(LCFont.semibold(12))
                    .foregroundStyle(.tertiary)

                LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
                    ForEach(Sensitivity.allCases, id: \.rawValue) { s in
                        Button {
                            Task { await vm.saveSensitivity(s.rawValue) }
                        } label: {
                            VStack(spacing: 4) {
                                Text(s.label)
                                    .font(LCFont.medium(13))
                                Text(s.desc)
                                    .font(LCFont.body(11))
                                    .foregroundStyle(.secondary)
                            }
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 10)
                            .background(vm.sensitivity == s.rawValue ? LCColor.accent.opacity(0.1) : Color.secondary.opacity(0.08))
                            .clipShape(RoundedRectangle(cornerRadius: LCRadius.r2))
                            .overlay(
                                RoundedRectangle(cornerRadius: LCRadius.r2)
                                    .stroke(vm.sensitivity == s.rawValue ? LCColor.accent : .clear, lineWidth: 1.5)
                            )
                        }
                        .buttonStyle(.plain)
                    }
                }
            }
        }
    }

    // MARK: - Presets Tab

    private var presetsTab: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("TEMPLATES")
                .font(LCFont.semibold(12))
                .foregroundStyle(.tertiary)

            FlowLayout(spacing: 6) {
                ForEach(BuiltinPreset.allCases, id: \.rawValue) { bp in
                    let used = vm.presets.contains { $0.builtinKey == bp.rawValue }
                    Button {
                        if !used {
                            Task { await vm.addPreset(name: bp.name, prompt: bp.prompt, builtinKey: bp.rawValue) }
                        }
                    } label: {
                        Text(bp.name)
                            .font(LCFont.body(12))
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .background(Color.secondary.opacity(0.1))
                            .clipShape(RoundedRectangle(cornerRadius: LCRadius.r1))
                            .opacity(used ? 0.4 : 1)
                    }
                    .buttonStyle(.plain)
                    .disabled(used)
                }
            }

            Divider()

            Text("MY PRESETS")
                .font(LCFont.semibold(12))
                .foregroundStyle(.tertiary)

            ForEach(vm.presets) { preset in
                HStack {
                    Circle()
                        .fill(preset.active ? LCColor.accent : .clear)
                        .stroke(preset.active ? LCColor.accent : Color.secondary, lineWidth: 2)
                        .frame(width: 10, height: 10)
                    VStack(alignment: .leading) {
                        Text(preset.name).font(LCFont.medium(13))
                        Text(preset.prompt).font(LCFont.body(12)).foregroundStyle(.tertiary).lineLimit(1)
                    }
                    Spacer()
                    Button { Task { await vm.deletePreset(preset.id) } } label: {
                        Image(systemName: "trash").font(.system(size: 13)).foregroundStyle(.secondary)
                    }
                }
                .padding(10)
                .background(.quaternary.opacity(0.3))
                .clipShape(RoundedRectangle(cornerRadius: LCRadius.r2))
                .onTapGesture { Task { await vm.togglePreset(preset.id) } }
            }
        }
    }

    // MARK: - Appearance Tab

    private var appearanceTab: some View {
        VStack(spacing: 16) {
            HStack {
                VStack(alignment: .leading) {
                    Text("Theme").font(LCFont.medium(14))
                    Text("Auto follows your system preference").font(LCFont.body(12)).foregroundStyle(.tertiary)
                }
                Spacer()
                Picker("", selection: Binding(
                    get: { ThemeManager.shared.preference },
                    set: { pref in
                        ThemeManager.shared.preference = pref
                        Task { await vm.updateTheme(pref.rawValue) }
                    }
                )) {
                    ForEach(ThemePreference.allCases, id: \.self) { pref in
                        Label(pref.label, systemImage: pref.icon).tag(pref)
                    }
                }
                .pickerStyle(.segmented)
                .frame(width: 200)
            }

            HStack {
                VStack(alignment: .leading) {
                    Text("Compact Messages").font(LCFont.medium(14))
                    Text("Reduce spacing between messages").font(LCFont.body(12)).foregroundStyle(.tertiary)
                }
                Spacer()
                Toggle("", isOn: Binding(get: { vm.settings.compact ?? false }, set: { c in Task { await vm.updateCompact(c) } }))
                    .tint(LCColor.accent)
            }
        }
    }

    // MARK: - Subscription Tab

    private var subscriptionTab: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let tier = vm.tierData {
                let labels: [String: String] = ["basic": "Basic", "premium": "Premium", "selfservice": "Self-Service"]
                Text(labels[tier.tier ?? "basic"] ?? tier.tier ?? "Basic")
                    .font(LCFont.bold(16))
                Text("Rate limit: \(tier.rpm ?? 30) req/min")
                    .font(LCFont.body(11))
                    .foregroundStyle(.tertiary)

                if tier.tier != "premium" {
                    if tier.upgradeRequest == "premium" {
                        Text("Upgrade to Premium requested — waiting for admin approval")
                            .font(LCFont.body(12))
                            .padding(10)
                            .background(LCColor.orange.opacity(0.08))
                            .clipShape(RoundedRectangle(cornerRadius: LCRadius.r1))
                    } else {
                        Button {
                            Task {
                                if await vm.requestUpgrade() { await vm.loadTier() }
                            }
                        } label: {
                            Text("Upgrade to Premium")
                                .font(LCFont.semibold(14))
                                .frame(maxWidth: .infinity)
                                .padding(12)
                                .background(LCColor.accent)
                                .foregroundStyle(.white)
                                .clipShape(RoundedRectangle(cornerRadius: LCRadius.r2))
                        }
                    }
                }

                Divider()

                Text("PROVIDER ACCESS")
                    .font(LCFont.semibold(12))
                    .foregroundStyle(.tertiary)

                ForEach(tier.providers ?? []) { p in
                    HStack(spacing: 8) {
                        Circle()
                            .fill(p.access == "locked" ? Color.secondary.opacity(0.3) : LCColor.accent)
                            .frame(width: 6, height: 6)
                        Text(p.name.capitalized)
                            .font(LCFont.body(13))
                            .foregroundStyle(p.access == "locked" ? .tertiary : .primary)
                        Spacer()
                        Text(accessLabel(p.access))
                            .font(LCFont.medium(11))
                            .foregroundStyle(p.access == "locked" ? Color.secondary : LCColor.accent)
                    }
                    .padding(.vertical, 4)
                }
            } else {
                ProgressView()
            }
        }
        .task { await vm.loadTier() }
    }

    // MARK: - Account Tab

    private var accountTab: some View {
        VStack(spacing: 16) {
            Button(role: .destructive) {
                Task { await appState.logout() }
                dismiss()
            } label: {
                Text("Sign Out")
                    .font(LCFont.medium(14))
                    .frame(maxWidth: .infinity)
                    .padding(12)
                    .background(LCColor.red.opacity(0.1))
                    .foregroundStyle(LCColor.red)
                    .clipShape(RoundedRectangle(cornerRadius: LCRadius.r2))
            }
        }
    }

    private func accessLabel(_ access: String) -> String {
        switch access {
        case "available": "Included"
        case "collector": "Free"
        case "byok": "Your Key"
        case "locked": "Not in plan"
        default: access
        }
    }
}

// MARK: - FlowLayout (for preset chips)

struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let result = arrange(proposal: proposal, subviews: subviews)
        return result.size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let result = arrange(proposal: proposal, subviews: subviews)
        for (idx, pos) in result.positions.enumerated() {
            subviews[idx].place(at: CGPoint(x: bounds.minX + pos.x, y: bounds.minY + pos.y), proposal: ProposedViewSize(subviews[idx].sizeThatFits(.unspecified)))
        }
    }

    private func arrange(proposal: ProposedViewSize, subviews: Subviews) -> (size: CGSize, positions: [CGPoint]) {
        let maxWidth = proposal.width ?? .infinity
        var positions: [CGPoint] = []
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0

        for sub in subviews {
            let size = sub.sizeThatFits(.unspecified)
            if x + size.width > maxWidth && x > 0 {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            positions.append(CGPoint(x: x, y: y))
            rowHeight = max(rowHeight, size.height)
            x += size.width + spacing
        }

        return (CGSize(width: maxWidth, height: y + rowHeight), positions)
    }
}
