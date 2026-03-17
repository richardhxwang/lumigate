import Foundation

struct TierData: Codable, Sendable {
    let tier: String?
    let pending: Bool?
    let rpm: Int?
    let providers: [ProviderAccess]?
    let upgradeRequest: String?
}

struct ProviderAccess: Codable, Identifiable, Sendable {
    var id: String { name }
    let name: String
    let access: String   // "available" | "locked" | "collector" | "byok"
    let keyUrl: String?
}

struct APIKeyInfo: Codable, Identifiable, Sendable {
    let id: String
    let provider: String
    let label: String
    let enabled: Bool
    let keyPreview: String
}
