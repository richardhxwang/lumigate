import SwiftUI

struct ModelPickerSheet: View {
    let currentProvider: String
    let currentModel: String
    let onSelect: (String, String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var vm = ModelPickerViewModel()

    var body: some View {
        NavigationStack {
            Group {
                if vm.selectedProvider == nil {
                    providerList
                } else {
                    modelList
                }
            }
            .navigationTitle(vm.selectedProvider == nil ? "Choose Provider" : vm.selectedProvider!.capitalized)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    if vm.selectedProvider != nil {
                        Button { vm.goBack() } label: {
                            HStack(spacing: 4) {
                                Image(systemName: "chevron.left")
                                    .font(.system(size: 14, weight: .medium))
                                Text("Providers")
                                    .font(LCFont.body(15))
                            }
                        }
                    } else {
                        Button("Cancel") { dismiss() }
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .task { await vm.loadProviders() }
    }

    // MARK: - Provider List

    private var providerList: some View {
        ScrollView {
            LazyVStack(spacing: 4) {
                if vm.isLoadingProviders {
                    ProgressView().padding(.top, 40)
                } else {
                    ForEach(vm.providers) { provider in
                        ProviderRow(
                            name: provider.name,
                            isSelected: provider.name == currentProvider
                        ) {
                            Task { await vm.selectProvider(provider.name) }
                        }
                    }
                }
            }
            .padding(12)
        }
    }

    // MARK: - Model List

    private var modelList: some View {
        ScrollView {
            LazyVStack(spacing: 4) {
                if vm.isLoadingModels {
                    ProgressView().padding(.top, 40)
                } else if vm.models.isEmpty {
                    Text("No models available")
                        .font(LCFont.body(14))
                        .foregroundStyle(.tertiary)
                        .padding(.top, 40)
                } else {
                    ForEach(vm.models) { model in
                        ModelRow(
                            model: model,
                            isSelected: model.id == currentModel && vm.selectedProvider == currentProvider
                        ) {
                            onSelect(vm.selectedProvider!, model.id)
                            dismiss()
                        }
                    }
                }
            }
            .padding(12)
        }
    }
}

// MARK: - Provider Row

struct ProviderRow: View {
    let name: String
    var isSelected: Bool = false
    let onTap: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 12) {
                // Provider icon
                ZStack {
                    RoundedRectangle(cornerRadius: 10)
                        .fill(Color(hex: ModelPickerViewModel.providerColors[name] ?? "#10a37f").opacity(0.15))
                    Image(systemName: ModelPickerViewModel.providerIcons[name] ?? "cpu")
                        .font(.system(size: 16))
                        .foregroundStyle(Color(hex: ModelPickerViewModel.providerColors[name] ?? "#10a37f"))
                }
                .frame(width: 36, height: 36)

                Text(name.capitalized)
                    .font(LCFont.medium(15))
                    .foregroundStyle(.primary)

                Spacer()

                if isSelected {
                    Image(systemName: "checkmark")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(LCColor.accent)
                }

                Image(systemName: "chevron.right")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(
                isSelected
                    ? LCColor.accent.opacity(0.06)
                    : (colorScheme == .dark ? Color.white.opacity(0.04) : Color.black.opacity(0.02))
            )
            .clipShape(RoundedRectangle(cornerRadius: LCRadius.r2))
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Model Row

struct ModelRow: View {
    let model: ModelInfo
    var isSelected: Bool = false
    let onTap: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        Button(action: onTap) {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text(ModelFormatter.format(model.id))
                        .font(LCFont.medium(15))
                        .foregroundStyle(.primary)

                    Spacer()

                    if isSelected {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.system(size: 18))
                            .foregroundStyle(LCColor.accent)
                    }
                }

                // Capabilities & context
                HStack(spacing: 8) {
                    if let caps = model.capabilities {
                        ForEach(caps, id: \.self) { cap in
                            capBadge(cap)
                        }
                    }
                    if let ctx = model.context_window, ctx > 0 {
                        Text(formatContext(ctx))
                            .font(LCFont.mono(10))
                            .foregroundStyle(.tertiary)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Color.secondary.opacity(0.08))
                            .clipShape(RoundedRectangle(cornerRadius: 4))
                    }
                }

                // Price
                if let price = model.price {
                    HStack(spacing: 4) {
                        Text("$\(formatPrice(price.in))/M in")
                            .font(LCFont.mono(10))
                        Text("$\(formatPrice(price.out))/M out")
                            .font(LCFont.mono(10))
                    }
                    .foregroundStyle(.tertiary)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(
                isSelected
                    ? LCColor.accent.opacity(0.06)
                    : (colorScheme == .dark ? Color.white.opacity(0.04) : Color.black.opacity(0.02))
            )
            .clipShape(RoundedRectangle(cornerRadius: LCRadius.r2))
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private func capBadge(_ cap: String) -> some View {
        let (icon, label) = capInfo(cap)
        HStack(spacing: 3) {
            Image(systemName: icon)
                .font(.system(size: 9))
            Text(label)
                .font(LCFont.body(10))
        }
        .foregroundStyle(.secondary)
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(Color.secondary.opacity(0.08))
        .clipShape(RoundedRectangle(cornerRadius: 4))
    }

    private func capInfo(_ cap: String) -> (String, String) {
        switch cap {
        case "vision": ("eye", "Vision")
        case "tools", "function_calling": ("wrench", "Tools")
        case "streaming": ("bolt", "Stream")
        case "json_mode": ("curlybraces", "JSON")
        case "reasoning": ("brain", "Reason")
        default: ("cpu", cap)
        }
    }

    private func formatContext(_ tokens: Int) -> String {
        if tokens >= 1_000_000 { return "\(tokens / 1_000_000)M ctx" }
        return "\(tokens / 1_000)K ctx"
    }

    private func formatPrice(_ value: Double) -> String {
        if value == 0 { return "0" }
        if value < 0.01 { return String(format: "%.4f", value) }
        return String(format: "%.2f", value)
    }
}
