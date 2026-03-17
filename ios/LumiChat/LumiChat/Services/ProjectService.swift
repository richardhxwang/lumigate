import Foundation

actor ProjectService {
    static let shared = ProjectService()
    private let api = APIClient.shared

    func loadProjects() async throws -> [Project] {
        let list: PBList<Project> = try await api.request("/lc/projects")
        return list.items
    }

    func createProject(name: String, color: String, instructions: String = "", memory: String = "") async throws -> Project {
        struct Body: Encodable {
            let name: String; let color: String; let instructions: String; let memory: String
        }
        return try await api.request("/lc/projects", method: "POST", body: Body(name: name, color: color, instructions: instructions, memory: memory))
    }

    func updateProject(_ id: String, name: String, color: String, instructions: String, memory: String) async throws -> Project {
        struct Body: Encodable {
            let name: String; let color: String; let instructions: String; let memory: String
        }
        return try await api.request("/lc/projects/\(id)", method: "PATCH", body: Body(name: name, color: color, instructions: instructions, memory: memory))
    }

    func deleteProject(_ id: String) async throws {
        let _: SimpleResponse = try await api.request("/lc/projects/\(id)", method: "DELETE")
    }
}
