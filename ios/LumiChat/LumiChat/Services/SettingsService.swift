import Foundation

actor SettingsService {
    static let shared = SettingsService()
    private let api = APIClient.shared
    private(set) var settings = UserSettings(id: nil)

    func loadSettings() async throws -> UserSettings {
        settings = try await api.request("/lc/user/settings")
        return settings
    }

    func patchSettings(_ patch: [String: AnyCodable]) async throws {
        let _: UserSettings = try await api.request("/lc/user/settings", method: "PATCH", body: patch)
        // Reload to stay in sync
        settings = try await api.request("/lc/user/settings")
    }

    func updateMemory(_ memory: String) async throws {
        try await patchSettings(["memory": AnyCodable(memory)])
    }

    func updateSensitivity(_ sensitivity: String) async throws {
        try await patchSettings(["sensitivity": AnyCodable(sensitivity)])
    }

    func updatePresets(_ presets: [Preset]) async throws {
        let encoded = try JSONEncoder().encode(presets)
        let array = try JSONSerialization.jsonObject(with: encoded)
        try await patchSettings(["presets": AnyCodable(array)])
    }

    func updateTheme(_ theme: String) async throws {
        try await patchSettings(["theme": AnyCodable(theme)])
    }

    func updateCompact(_ compact: Bool) async throws {
        try await patchSettings(["compact": AnyCodable(compact)])
    }

    func updateDefaultModel(provider: String, model: String) async throws {
        try await patchSettings(["default_provider": AnyCodable(provider), "default_model": AnyCodable(model)])
    }

    func updateActiveProject(_ projectId: String?) async throws {
        try await patchSettings(["active_project": AnyCodable(projectId ?? "")])
    }

    /// Build system prompt from memory + sensitivity + active preset
    func getActiveSystemPrompt(activeProject: Project?) -> String {
        var parts: [String] = []
        if let proj = activeProject {
            if !proj.instructions.isEmpty { parts.append(proj.instructions) }
            if !proj.memory.isEmpty { parts.append("Project context:\n\(proj.memory)") }
        }
        if let mem = settings.memory, !mem.isEmpty { parts.append(mem) }
        let sens = Sensitivity(rawValue: settings.sensitivity ?? "default") ?? .default
        if let sp = sens.systemPrompt { parts.append(sp) }
        if let presets = settings.presets, let active = presets.first(where: { $0.active }) {
            parts.append(active.prompt)
        }
        return parts.joined(separator: "\n\n")
    }
}
