import Foundation

struct ChatSession: Codable, Identifiable, Sendable {
    let id: String
    var title: String
    var provider: String?
    var model: String?
    var project: String?
    let user: String?
    let created: String?
    var updated: String?
}

struct PBList<T: Codable & Sendable>: Codable, Sendable {
    let page: Int?
    let perPage: Int?
    let totalItems: Int?
    let items: [T]
}
