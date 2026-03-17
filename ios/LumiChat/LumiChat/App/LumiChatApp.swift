import SwiftUI

@main
struct LumiChatApp: App {
    @State private var appState = AppState()
    @State private var themeManager = ThemeManager.shared

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environment(appState)
                .preferredColorScheme(themeManager.preferredColorScheme)
                .task {
                    await appState.bootstrap()
                }
        }
    }
}
