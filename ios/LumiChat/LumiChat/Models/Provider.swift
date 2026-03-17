import Foundation

struct ProviderInfo: Codable, Identifiable, Sendable {
    var id: String { name }
    let name: String
    let baseUrl: String?
    let available: Bool
}

struct ModelInfo: Codable, Identifiable, Sendable {
    let id: String
    let object: String?
    let owned_by: String?
    var price: ModelPrice?
    var desc: String?
    var capabilities: [String]?
    var context_window: Int?
}

struct ModelPrice: Codable, Sendable {
    let `in`: Double
    let out: Double
}
