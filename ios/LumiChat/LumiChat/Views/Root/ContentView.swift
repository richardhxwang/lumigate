import SwiftUI
import UIKit

struct ContentView: View {
    @Environment(AppState.self) private var appState

    var body: some View {
        ZStack {
            if appState.isAuthenticated {
                MainView()
                    .transition(.opacity.combined(with: .move(edge: .bottom)))
            } else if !appState.showSplash {
                AuthView()
                    .transition(.opacity)
            }

            if appState.showSplash {
                SplashView()
                    .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.5), value: appState.showSplash)
        .animation(.spring(duration: 0.6), value: appState.isAuthenticated)
    }
}

struct MainView: View {
    @State private var chatVM = ChatViewModel()
    @State private var sidebarVM = SidebarViewModel()
    @State private var projectVM = ProjectViewModel()
    @State private var showSettings = false
    @State private var showModelPicker = false
    @State private var showProjectPicker = false
    @Environment(\.colorScheme) private var colorScheme

    @State private var showSidebar = false

    var body: some View {
        ZStack {
            // Main chat area (always visible)
            VStack(spacing: 0) {
                // Header bar
                ChatHeaderBar(
                    chatVM: chatVM,
                    activeProject: projectVM.activeProject,
                    onModelTap: { showModelPicker = true },
                    onProjectTap: { showProjectPicker = true },
                    onMenuTap: { withAnimation(.spring(duration: 0.3)) { showSidebar = true } },
                    onNewChat: { chatVM.newChat() }
                )

                // Offline banner
                if !NetworkMonitor.shared.isConnected {
                    HStack(spacing: 6) {
                        Image(systemName: "wifi.slash")
                            .font(.system(size: 12))
                        Text("No internet connection")
                            .font(LCFont.body(12))
                    }
                    .foregroundStyle(LCColor.orange)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 6)
                    .frame(maxWidth: .infinity)
                    .background(LCColor.orange.opacity(0.08))
                }

                // Error banner
                if let error = chatVM.errorMessage {
                    HStack(spacing: 6) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(.system(size: 12))
                        Text(error)
                            .font(LCFont.body(12))
                            .lineLimit(2)
                        Spacer()
                        Button {
                            chatVM.errorMessage = nil
                        } label: {
                            Image(systemName: "xmark")
                                .font(.system(size: 11, weight: .medium))
                        }
                    }
                    .foregroundStyle(LCColor.red)
                    .padding(.horizontal, 16)
                    .padding(.vertical, 8)
                    .background(LCColor.red.opacity(0.08))
                }

                ChatView(viewModel: chatVM)
            }

            // Sidebar overlay
            if showSidebar {
                Color.black.opacity(0.3)
                    .ignoresSafeArea()
                    .onTapGesture {
                        withAnimation(.spring(duration: 0.3)) { showSidebar = false }
                    }

                HStack(spacing: 0) {
                    SidebarView(
                        viewModel: sidebarVM,
                        onSelectSession: { session in
                            Task { await chatVM.loadSession(session) }
                            withAnimation(.spring(duration: 0.3)) { showSidebar = false }
                        },
                        onNewChat: {
                            chatVM.newChat()
                            withAnimation(.spring(duration: 0.3)) { showSidebar = false }
                        },
                        activeSessionId: chatVM.currentSessionId,
                        onSettings: {
                            showSettings = true
                            withAnimation(.spring(duration: 0.3)) { showSidebar = false }
                        }
                    )
                    .frame(width: min(UIScreen.main.bounds.width * 0.82, 320))
                    .background(Color(colorScheme == .dark ? LCColor.Dark.sb : LCColor.Light.sb))

                    Spacer(minLength: 0)
                }
                .transition(.move(edge: .leading))
            }
        }
        .tint(LCColor.accent)
        .onChange(of: projectVM.activeProject?.id) { _, _ in
            chatVM.activeProject = projectVM.activeProject
        }
        .task {
            await projectVM.load()
            chatVM.activeProject = projectVM.activeProject
            chatVM.onSessionCreated = { session in
                sidebarVM.addSession(session)
            }
            chatVM.onSessionUpdated = { id, title in
                if let idx = sidebarVM.sessions.firstIndex(where: { $0.id == id }) {
                    sidebarVM.sessions[idx].title = title
                }
            }
            TokenKeepAlive.shared.start()
            NetworkMonitor.shared.start()
        }
        .onDisappear {
            TokenKeepAlive.shared.stop()
        }
        .onTapGesture { TokenKeepAlive.shared.trackActivity() }
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.willEnterForegroundNotification)) { _ in
            TokenKeepAlive.shared.trackActivity()
        }
        .sheet(isPresented: $showSettings) {
            SettingsSheet()
                .presentationDetents([.large])
        }
        .sheet(isPresented: $showModelPicker) {
            ModelPickerSheet(
                currentProvider: chatVM.selectedProvider,
                currentModel: chatVM.selectedModel
            ) { provider, model in
                chatVM.selectedProvider = provider
                chatVM.selectedModel = model
            }
        }
        .sheet(isPresented: $showProjectPicker) {
            ProjectPickerSheet(vm: projectVM)
        }
        // Keyboard shortcuts (iPad + external keyboard)
        .keyboardShortcut("n", modifiers: .command, onPress: { chatVM.newChat() })
        .keyboardShortcut("k", modifiers: .command, onPress: { showModelPicker = true })
        .keyboardShortcut(",", modifiers: .command, onPress: { showSettings = true })
    }
}

// MARK: - Keyboard Shortcut Modifier

extension View {
    func keyboardShortcut(_ key: KeyEquivalent, modifiers: EventModifiers, onPress: @escaping () -> Void) -> some View {
        self.background(
            Button("") { onPress() }
                .keyboardShortcut(key, modifiers: modifiers)
                .frame(width: 0, height: 0)
                .opacity(0)
        )
    }
}
