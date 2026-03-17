import SwiftUI

@MainActor
@Observable
class SettingsViewModel {
    var settings = UserSettings(id: nil)
    var activeTab = "chat"
    var isLoading = false
    var tierData: TierData?

    // Edit states
    var memory = ""
    var sensitivity = "default"
    var presets: [Preset] = []

    private let settingsService = SettingsService.shared
    private let api = APIClient.shared

    func load() async {
        isLoading = true
        do {
            settings = try await settingsService.loadSettings()
            memory = settings.memory ?? ""
            sensitivity = settings.sensitivity ?? "default"
            presets = settings.presets ?? []
        } catch {}
        isLoading = false
    }

    func saveMemory() async {
        try? await settingsService.updateMemory(memory)
    }

    func saveSensitivity(_ value: String) async {
        sensitivity = value
        try? await settingsService.updateSensitivity(value)
    }

    func togglePreset(_ id: String) async {
        for i in presets.indices {
            presets[i].active = presets[i].id == id ? !presets[i].active : false
        }
        try? await settingsService.updatePresets(presets)
    }

    func addPreset(name: String, prompt: String, builtinKey: String? = nil) async {
        guard presets.count < 8 else { return }
        let p = Preset(id: UUID().uuidString, name: name, prompt: prompt, active: false, builtinKey: builtinKey)
        presets.append(p)
        try? await settingsService.updatePresets(presets)
    }

    func deletePreset(_ id: String) async {
        presets.removeAll { $0.id == id }
        try? await settingsService.updatePresets(presets)
    }

    func updateTheme(_ theme: String) async {
        try? await settingsService.updateTheme(theme)
    }

    func updateCompact(_ compact: Bool) async {
        try? await settingsService.updateCompact(compact)
    }

    func loadTier() async {
        tierData = try? await api.request("/lc/user/tier")
    }

    func requestUpgrade() async -> Bool {
        struct Body: Encodable { let plan: String }
        let resp: SimpleResponse? = try? await api.request("/lc/upgrade-request", method: "POST", body: Body(plan: "premium"))
        return resp?.success == true
    }
}
