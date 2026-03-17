import SwiftUI

struct Project: Codable, Identifiable, Sendable {
    let id: String
    var name: String
    var color: String
    var instructions: String
    var memory: String
    var sort_order: Int?
    let user: String?
    let created: String?
    var updated: String?
}

enum ProjectColor: String, CaseIterable {
    case teal = "#10a37f"
    case indigo = "#6366f1"
    case amber = "#f59e0b"
    case red = "#ef4444"
    case purple = "#8b5cf6"
    case pink = "#ec4899"
    case cyan = "#06b6d4"
    case lime = "#84cc16"

    var swiftColor: Color { Color(hex: rawValue) }
}
