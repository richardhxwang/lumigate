import Foundation

struct LCUser: Codable, Identifiable, Sendable {
    let id: String
    let email: String
    var name: String?
    var avatarUrl: String?
}

struct LoginResponse: Codable, Sendable {
    let ok: Bool?
    let record: LoginRecord?
    let error: String?
}

struct LoginRecord: Codable, Sendable {
    let id: String
    let email: String
    let name: String?
}

struct CheckEmailResponse: Codable, Sendable {
    let exists: Bool
}

struct AuthMethodsResponse: Codable, Sendable {
    let password: Bool?
    let google: Bool?
}

struct SimpleResponse: Codable, Sendable {
    let ok: Bool?
    let success: Bool?
    let error: String?
}
