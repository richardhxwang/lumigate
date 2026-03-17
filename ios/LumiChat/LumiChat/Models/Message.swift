import Foundation

struct ChatMessage: Codable, Identifiable, Sendable {
    let id: String
    let session: String?
    let role: String        // "user" | "assistant"
    var content: String
    var file_ids: [String]?
    let created: String?
}

// For SSE streaming
struct SSEDelta: Codable, Sendable {
    let choices: [SSEChoice]?
    let usage: SSEUsage?
}

struct SSEChoice: Codable, Sendable {
    let delta: SSEDeltaContent?
    let finish_reason: String?
}

struct SSEDeltaContent: Codable, Sendable {
    let content: String?
    let tool_calls: [SSEToolCallDelta]?
}

struct SSEToolCallDelta: Codable, Sendable {
    let index: Int?
    let id: String?
    let function: SSEToolFunction?
}

struct SSEToolFunction: Codable, Sendable {
    let name: String?
    let arguments: String?
}

struct SSEUsage: Codable, Sendable {
    let prompt_tokens: Int?
    let completion_tokens: Int?
}

// For building AI request
struct ChatPayload: Codable, Sendable {
    let model: String
    var messages: [[String: AnyCodable]]
    var stream: Bool = true
    var max_tokens: Int?
    var max_completion_tokens: Int?
    var stream_options: StreamOptions?
    var tools: [AnyCodable]?
    var tool_choice: String?
}

struct StreamOptions: Codable, Sendable {
    let include_usage: Bool
}

// Generic Codable wrapper for JSON
struct AnyCodable: Codable, @unchecked Sendable {
    let value: Any

    init(_ value: Any) { self.value = value }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let s = try? container.decode(String.self) { value = s }
        else if let i = try? container.decode(Int.self) { value = i }
        else if let d = try? container.decode(Double.self) { value = d }
        else if let b = try? container.decode(Bool.self) { value = b }
        else if let a = try? container.decode([AnyCodable].self) { value = a.map(\.value) }
        else if let d = try? container.decode([String: AnyCodable].self) { value = d.mapValues(\.value) }
        else { value = NSNull() }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch value {
        case let s as String: try container.encode(s)
        case let i as Int: try container.encode(i)
        case let d as Double: try container.encode(d)
        case let b as Bool: try container.encode(b)
        case let a as [Any]: try container.encode(a.map { AnyCodable($0) })
        case let d as [String: Any]: try container.encode(d.mapValues { AnyCodable($0) })
        default: try container.encodeNil()
        }
    }
}
