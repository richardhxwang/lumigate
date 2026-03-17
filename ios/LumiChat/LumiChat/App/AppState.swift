import SwiftUI

@MainActor
@Observable
class AppState {
    var isAuthenticated = false
    var currentUser: LCUser?
    var showSplash = true

    private let auth = AuthService.shared

    func bootstrap() async {
        // Try to restore session from Keychain
        let restored = await auth.restoreSession()
        if restored {
            currentUser = await auth.currentUser
            isAuthenticated = true
        }
        // Dismiss splash after a minimum display time
        try? await Task.sleep(for: .seconds(1.5))
        withAnimation(.easeOut(duration: 0.4)) {
            showSplash = false
        }
    }

    func onLoginSuccess(_ user: LCUser) {
        currentUser = user
        withAnimation(.spring(duration: 0.5)) {
            isAuthenticated = true
        }
    }

    func logout() async {
        await auth.logout()
        withAnimation(.spring(duration: 0.3)) {
            isAuthenticated = false
            currentUser = nil
        }
    }
}
