import SwiftUI

struct SidebarView: View {
    @Bindable var viewModel: SidebarViewModel
    let onSelectSession: (ChatSession) -> Void
    let onNewChat: () -> Void
    var activeSessionId: String?
    var onSettings: (() -> Void)?

    @State private var editingId: String?
    @State private var editTitle = ""

    var body: some View {
        VStack(spacing: 0) {
            // Top bar
            HStack(spacing: 8) {
                Button(action: onNewChat) {
                    LumiChatLogo(size: 22)
                }
                .padding(.leading, 4)

                Button(action: onNewChat) {
                    HStack(spacing: 8) {
                        Image(systemName: "plus")
                            .font(.system(size: 16, weight: .medium))
                        Text("New chat")
                            .font(LCFont.body(13.5))
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 10)
                    .frame(height: 36)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(.primary)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)

            // Search
            if !viewModel.sessions.isEmpty {
                HStack(spacing: 0) {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: 13))
                        .foregroundStyle(.tertiary)
                        .padding(.leading, 10)
                    TextField("Search chats...", text: $viewModel.searchQuery)
                        .font(LCFont.body(13))
                        .padding(7)
                }
                .background(.quaternary.opacity(0.5))
                .clipShape(RoundedRectangle(cornerRadius: LCRadius.r2))
                .padding(.horizontal, 10)
                .padding(.bottom, 6)
            }

            // Session list
            List {
                ForEach(viewModel.groupedSessions, id: \.label) { group in
                    Section {
                        ForEach(group.items) { session in
                            SessionRow(
                                session: session,
                                isActive: session.id == activeSessionId,
                                isEditing: editingId == session.id,
                                editTitle: editingId == session.id ? $editTitle : .constant(""),
                                onTap: {
                                    Haptics.select()
                                    onSelectSession(session)
                                },
                                onRename: { startRename(session) },
                                onCommitRename: { commitRename(session.id) },
                                onDelete: { Task { await viewModel.deleteSession(session.id) } }
                            )
                            .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                                Button(role: .destructive) {
                                    Task { await viewModel.deleteSession(session.id) }
                                } label: {
                                    Label("Delete", systemImage: "trash")
                                }
                            }
                            .swipeActions(edge: .leading) {
                                Button { startRename(session) } label: {
                                    Label("Rename", systemImage: "pencil")
                                }
                                .tint(LCColor.accent)
                            }
                            .listRowInsets(EdgeInsets(top: 0, leading: 4, bottom: 0, trailing: 4))
                            .listRowSeparator(.hidden)
                            .listRowBackground(Color.clear)
                        }
                    } header: {
                        Text(group.label)
                            .font(LCFont.semibold(11))
                            .foregroundStyle(.tertiary)
                            .textCase(.uppercase)
                    }
                }
            }
            .listStyle(.plain)
            .scrollIndicators(.hidden)
            .refreshable {
                await viewModel.loadSessions()
            }

            Spacer(minLength: 0)

            // Footer
            UserFooter(onSettings: onSettings)
        }
        .task { await viewModel.loadSessions() }
    }

    private func startRename(_ session: ChatSession) {
        editingId = session.id
        editTitle = session.title
    }

    private func commitRename(_ id: String) {
        let title = editTitle.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !title.isEmpty else { editingId = nil; return }
        Task { await viewModel.renameSession(id, title: title) }
        editingId = nil
    }
}

// MARK: - Session Row

struct SessionRow: View {
    let session: ChatSession
    let isActive: Bool
    var isEditing: Bool = false
    @Binding var editTitle: String
    let onTap: () -> Void
    var onRename: (() -> Void)?
    var onCommitRename: (() -> Void)?
    var onDelete: (() -> Void)?

    var body: some View {
        Group {
            if isEditing {
                TextField("Title", text: $editTitle, onCommit: { onCommitRename?() })
                    .font(LCFont.body(15))
                    .padding(.horizontal, 10)
                    .padding(.vertical, 10)
                    .background(.quaternary.opacity(0.5))
                    .clipShape(RoundedRectangle(cornerRadius: LCRadius.r1))
            } else {
                Button(action: onTap) {
                    Text(session.title)
                        .font(LCFont.body(15))
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 10)
                        .background(isActive ? Color.primary.opacity(0.08) : .clear)
                        .clipShape(RoundedRectangle(cornerRadius: LCRadius.r1))
                }
                .buttonStyle(.plain)
                .contextMenu {
                    Button("Rename", systemImage: "pencil") { onRename?() }
                    Button("Delete", systemImage: "trash", role: .destructive) { onDelete?() }
                }
            }
        }
        .padding(.horizontal, 8)
    }
}

// MARK: - User Footer

struct UserFooter: View {
    @Environment(AppState.self) private var appState
    var onSettings: (() -> Void)?

    var body: some View {
        HStack(spacing: 8) {
            // Avatar
            ZStack {
                Circle().fill(LCColor.accent)
                Text(initial)
                    .font(LCFont.bold(12))
                    .foregroundStyle(.white)
            }
            .frame(width: 28, height: 28)

            VStack(alignment: .leading, spacing: 1) {
                Text(appState.currentUser?.name ?? appState.currentUser.map { $0.email.components(separatedBy: "@").first ?? $0.email } ?? "?")
                    .font(LCFont.body(13))
                    .lineLimit(1)
                Text(appState.currentUser?.email ?? "")
                    .font(LCFont.body(11))
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }

            Spacer()

            // Settings gear
            Button {
                onSettings?()
            } label: {
                Image(systemName: "gearshape")
                    .font(.system(size: 15))
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .overlay(alignment: .top) {
            Divider()
        }
    }

    private var initial: String {
        let name = appState.currentUser?.name ?? appState.currentUser?.email ?? "?"
        return String(name.prefix(1)).uppercased()
    }
}
