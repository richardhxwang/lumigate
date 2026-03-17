import SwiftUI

struct ProjectEditorSheet: View {
    @Environment(\.dismiss) private var dismiss
    var existing: Project?
    let onSave: (Project) -> Void

    @State private var name: String
    @State private var color: String
    @State private var instructions: String
    @State private var memory: String
    @State private var isSaving = false

    init(existing: Project? = nil, onSave: @escaping (Project) -> Void) {
        self.existing = existing
        self.onSave = onSave
        _name = State(initialValue: existing?.name ?? "")
        _color = State(initialValue: existing?.color ?? ProjectColor.teal.rawValue)
        _instructions = State(initialValue: existing?.instructions ?? "")
        _memory = State(initialValue: existing?.memory ?? "")
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    // Name
                    VStack(alignment: .leading, spacing: 6) {
                        Text("NAME").font(LCFont.semibold(12)).foregroundStyle(.tertiary)
                        TextField("Project name", text: $name)
                            .font(LCFont.body(15))
                            .padding(12)
                            .background(.quaternary.opacity(0.5))
                            .clipShape(RoundedRectangle(cornerRadius: LCRadius.r2))
                    }

                    // Color
                    VStack(alignment: .leading, spacing: 8) {
                        Text("COLOR").font(LCFont.semibold(12)).foregroundStyle(.tertiary)
                        HStack(spacing: 12) {
                            ForEach(ProjectColor.allCases, id: \.rawValue) { pc in
                                Circle()
                                    .fill(pc.swiftColor)
                                    .frame(width: 24, height: 24)
                                    .overlay(
                                        Circle().stroke(.white, lineWidth: color == pc.rawValue ? 2 : 0)
                                    )
                                    .scaleEffect(color == pc.rawValue ? 1.15 : 1)
                                    .onTapGesture { withAnimation(.spring(duration: 0.2)) { color = pc.rawValue } }
                            }
                        }
                    }

                    // Instructions
                    VStack(alignment: .leading, spacing: 6) {
                        Text("INSTRUCTIONS").font(LCFont.semibold(12)).foregroundStyle(.tertiary)
                        TextEditor(text: $instructions)
                            .font(LCFont.body(13.5))
                            .frame(minHeight: 100)
                            .padding(10)
                            .background(.quaternary.opacity(0.5))
                            .clipShape(RoundedRectangle(cornerRadius: LCRadius.r2))
                        Text("System prompt for this project.")
                            .font(LCFont.body(11)).foregroundStyle(.tertiary)
                    }

                    // Memory
                    VStack(alignment: .leading, spacing: 6) {
                        Text("MEMORY").font(LCFont.semibold(12)).foregroundStyle(.tertiary)
                        TextEditor(text: $memory)
                            .font(LCFont.body(13.5))
                            .frame(minHeight: 80)
                            .padding(10)
                            .background(.quaternary.opacity(0.5))
                            .clipShape(RoundedRectangle(cornerRadius: LCRadius.r2))
                        Text("Background context the AI should always know.")
                            .font(LCFont.body(11)).foregroundStyle(.tertiary)
                    }
                }
                .padding(24)
            }
            .navigationTitle(existing == nil ? "New Project" : "Edit Project")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { save() }
                        .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty || isSaving)
                        .foregroundStyle(LCColor.accent)
                }
            }
        }
    }

    private func save() {
        isSaving = true
        let proj = Project(
            id: existing?.id ?? "",
            name: name.trimmingCharacters(in: .whitespaces),
            color: color,
            instructions: instructions,
            memory: memory,
            sort_order: existing?.sort_order,
            user: existing?.user,
            created: existing?.created,
            updated: nil
        )
        onSave(proj)
        dismiss()
    }
}
