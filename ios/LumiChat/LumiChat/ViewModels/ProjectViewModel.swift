import SwiftUI

@MainActor
@Observable
class ProjectViewModel {
    var projects: [Project] = []
    var activeProjectId: String?
    var isLoading = false

    private let projectService = ProjectService.shared
    private let settingsService = SettingsService.shared

    var activeProject: Project? {
        projects.first { $0.id == activeProjectId }
    }

    func load() async {
        isLoading = true
        do {
            projects = try await projectService.loadProjects()
            let settings = try await settingsService.loadSettings()
            activeProjectId = settings.active_project
        } catch {}
        isLoading = false
    }

    func selectProject(_ id: String?) async {
        activeProjectId = id
        try? await settingsService.updateActiveProject(id)
    }

    func createProject(name: String, color: String, instructions: String, memory: String) async {
        do {
            let p = try await projectService.createProject(name: name, color: color, instructions: instructions, memory: memory)
            projects.append(p)
        } catch {}
    }

    func updateProject(_ project: Project) async {
        do {
            let updated = try await projectService.updateProject(
                project.id, name: project.name, color: project.color,
                instructions: project.instructions, memory: project.memory
            )
            if let idx = projects.firstIndex(where: { $0.id == project.id }) {
                projects[idx] = updated
            }
        } catch {}
    }

    func deleteProject(_ id: String) async {
        try? await projectService.deleteProject(id)
        projects.removeAll { $0.id == id }
        if activeProjectId == id {
            activeProjectId = nil
            try? await settingsService.updateActiveProject(nil)
        }
    }
}
