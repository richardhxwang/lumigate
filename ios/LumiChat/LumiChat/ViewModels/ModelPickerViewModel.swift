import SwiftUI

@MainActor
@Observable
class ModelPickerViewModel {
    var providers: [ProviderInfo] = []
    var models: [ModelInfo] = []
    var selectedProvider: String?
    var isLoadingProviders = false
    var isLoadingModels = false

    private let providerService = ProviderService.shared

    /// Provider display config
    static let providerIcons: [String: String] = [
        "openai": "bolt.fill",
        "anthropic": "brain",
        "gemini": "sparkles",
        "deepseek": "magnifyingglass",
        "kimi": "moon.fill",
        "doubao": "leaf.fill",
        "qwen": "cloud.fill",
        "minimax": "waveform"
    ]

    static let providerColors: [String: String] = [
        "openai": "#10a37f",
        "anthropic": "#d4a574",
        "gemini": "#4285f4",
        "deepseek": "#536dfe",
        "kimi": "#6366f1",
        "doubao": "#00d4aa",
        "qwen": "#6c5ce7",
        "minimax": "#ff6b6b"
    ]

    func loadProviders() async {
        isLoadingProviders = true
        do {
            providers = try await providerService.loadProviders()
                .filter { $0.available }
        } catch {}
        isLoadingProviders = false
    }

    func selectProvider(_ name: String) async {
        selectedProvider = name
        isLoadingModels = true
        models = []
        do {
            models = try await providerService.loadModels(provider: name)
        } catch {}
        isLoadingModels = false
    }

    func goBack() {
        selectedProvider = nil
        models = []
    }
}
