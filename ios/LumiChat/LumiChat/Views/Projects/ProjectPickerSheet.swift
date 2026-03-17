import SwiftUI

struct ProjectPickerSheet: View {
    @Bindable var vm: ProjectViewModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var colorScheme
    @State private var showEditor = false
    @State private var editingProject: Project?

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(spacing: 6) {
                    // "No project" option
                    Button {
                        Task { await vm.selectProject(nil) }
                        dismiss()
                    } label: {
                        HStack(spacing: 12) {
                            ZStack {
                                RoundedRectangle(cornerRadius: 8)
                                    .fill(Color.secondary.opacity(0.1))
                                Image(systemName: "minus.circle")
                                    .font(.system(size: 16))
                                    .foregroundStyle(.secondary)
                            }
                            .frame(width: 36, height: 36)

                            Text("No Project")
                                .font(LCFont.medium(15))
                                .foregroundStyle(.primary)

                            Spacer()

                            if vm.activeProjectId == nil {
                                Image(systemName: "checkmark.circle.fill")
                                    .font(.system(size: 18))
                                    .foregroundStyle(LCColor.accent)
                            }
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 12)
                        .background(
                            vm.activeProjectId == nil
                                ? LCColor.accent.opacity(0.06)
                                : (colorScheme == .dark ? Color.white.opacity(0.04) : Color.black.opacity(0.02))
                        )
                        .clipShape(RoundedRectangle(cornerRadius: LCRadius.r2))
                    }
                    .buttonStyle(.plain)

                    // Projects
                    ForEach(vm.projects) { project in
                        ProjectRow(
                            project: project,
                            isActive: project.id == vm.activeProjectId,
                            onSelect: {
                                Task { await vm.selectProject(project.id) }
                                dismiss()
                            },
                            onEdit: {
                                editingProject = project
                                showEditor = true
                            },
                            onDelete: {
                                Task { await vm.deleteProject(project.id) }
                            }
                        )
                    }
                }
                .padding(12)
            }
            .navigationTitle("Projects")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
                ToolbarItem(placement: .primaryAction) {
                    Button {
                        editingProject = nil
                        showEditor = true
                    } label: {
                        Image(systemName: "plus")
                    }
                }
            }
            .sheet(isPresented: $showEditor) {
                ProjectEditorSheet(existing: editingProject) { project in
                    Task {
                        if project.id.isEmpty {
                            await vm.createProject(name: project.name, color: project.color, instructions: project.instructions, memory: project.memory)
                        } else {
                            await vm.updateProject(project)
                        }
                    }
                }
            }
        }
        .presentationDetents([.medium, .large])
    }
}

// MARK: - Project Row

struct ProjectRow: View {
    let project: Project
    var isActive: Bool
    let onSelect: () -> Void
    var onEdit: (() -> Void)?
    var onDelete: (() -> Void)?
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        Button(action: onSelect) {
            HStack(spacing: 12) {
                ZStack {
                    RoundedRectangle(cornerRadius: 8)
                        .fill(Color(hex: project.color).opacity(0.15))
                    Image(systemName: "folder.fill")
                        .font(.system(size: 16))
                        .foregroundStyle(Color(hex: project.color))
                }
                .frame(width: 36, height: 36)

                VStack(alignment: .leading, spacing: 2) {
                    Text(project.name)
                        .font(LCFont.medium(15))
                        .foregroundStyle(.primary)
                    if !project.instructions.isEmpty {
                        Text(project.instructions)
                            .font(LCFont.body(12))
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                    }
                }

                Spacer()

                if isActive {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 18))
                        .foregroundStyle(LCColor.accent)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .background(
                isActive
                    ? LCColor.accent.opacity(0.06)
                    : (colorScheme == .dark ? Color.white.opacity(0.04) : Color.black.opacity(0.02))
            )
            .clipShape(RoundedRectangle(cornerRadius: LCRadius.r2))
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button("Edit", systemImage: "pencil") { onEdit?() }
            Button("Delete", systemImage: "trash", role: .destructive) { onDelete?() }
        }
    }
}
