import Foundation

actor SessionService {
    static let shared = SessionService()
    private let api = APIClient.shared

    func loadSessions() async throws -> [ChatSession] {
        let list: PBList<ChatSession> = try await api.request("/lc/sessions")
        return list.items
    }

    func createSession(title: String, provider: String, model: String, project: String? = nil) async throws -> ChatSession {
        struct Body: Encodable {
            let title: String; let provider: String; let model: String; let project: String?
        }
        return try await api.request("/lc/sessions", method: "POST", body: Body(title: title, provider: provider, model: model, project: project))
    }

    func loadMessages(sessionId: String) async throws -> [ChatMessage] {
        let list: PBList<ChatMessage> = try await api.request("/lc/sessions/\(sessionId)/messages")
        return list.items
    }

    func createMessage(session: String, role: String, content: String) async throws -> ChatMessage {
        struct Body: Encodable { let session: String; let role: String; let content: String }
        return try await api.request("/lc/messages", method: "POST", body: Body(session: session, role: role, content: content))
    }

    func deleteMessage(_ id: String) async throws {
        let _: SimpleResponse = try await api.request("/lc/messages/\(id)", method: "DELETE")
    }

    func deleteSession(_ id: String) async throws {
        let _: SimpleResponse = try await api.request("/lc/sessions/\(id)", method: "DELETE")
    }

    func renameSession(_ id: String, title: String) async throws {
        struct Body: Encodable { let title: String }
        let _: ChatSession = try await api.request("/lc/sessions/\(id)/title", method: "PATCH", body: Body(title: title))
    }
}
