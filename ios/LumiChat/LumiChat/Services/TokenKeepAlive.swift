import Foundation
import UIKit

/// Refreshes PocketBase auth token periodically while user is active
@MainActor
@Observable
class TokenKeepAlive {
    static let shared = TokenKeepAlive()

    private var refreshTimer: Timer?
    private var lastActivity: Date = Date()
    private let refreshInterval: TimeInterval = 30 * 60  // 30 min
    private let activeThreshold: TimeInterval = 10 * 60  // 10 min
    private let api = APIClient.shared

    func start() {
        stop()
        trackActivity()
        refreshTimer = Timer.scheduledTimer(withTimeInterval: refreshInterval, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.checkRefresh()
            }
        }
    }

    func stop() {
        refreshTimer?.invalidate()
        refreshTimer = nil
    }

    func trackActivity() {
        lastActivity = Date()
    }

    private func checkRefresh() {
        guard Date().timeIntervalSince(lastActivity) < activeThreshold else { return }
        Task {
            struct RefreshResponse: Codable, Sendable { let token: String? }
            let _: RefreshResponse? = try? await api.request("/lc/auth/refresh", method: "POST")
        }
    }
}
