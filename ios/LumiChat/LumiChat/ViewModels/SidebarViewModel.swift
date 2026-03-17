import SwiftUI

@MainActor
@Observable
class SidebarViewModel {
    var sessions: [ChatSession] = []
    var searchQuery = ""
    var isLoading = false

    private let sessionService = SessionService.shared

    var groupedSessions: [DateGrouper.Group<ChatSession>] {
        let filtered = searchQuery.isEmpty
            ? sessions
            : sessions.filter { $0.title.localizedCaseInsensitiveContains(searchQuery) }
        let sorted = filtered.sorted { ($0.updated ?? $0.created ?? "") > ($1.updated ?? $1.created ?? "") }
        return DateGrouper.group(sorted)
    }

    func loadSessions() async {
        isLoading = true
        do {
            sessions = try await sessionService.loadSessions()
        } catch {
            // Silently fail — sessions will be empty
        }
        isLoading = false
    }

    func deleteSession(_ id: String) async {
        try? await sessionService.deleteSession(id)
        sessions.removeAll { $0.id == id }
    }

    func renameSession(_ id: String, title: String) async {
        try? await sessionService.renameSession(id, title: title)
        if let idx = sessions.firstIndex(where: { $0.id == id }) {
            sessions[idx].title = title
        }
    }

    func addSession(_ session: ChatSession) {
        sessions.insert(session, at: 0)
    }
}
