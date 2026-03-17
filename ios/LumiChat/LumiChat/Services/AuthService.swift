import Foundation
import AuthenticationServices
import UIKit

actor AuthService {
    static let shared = AuthService()

    private let api = APIClient.shared
    private(set) var currentUser: LCUser?
    private(set) var isAuthenticated = false
    private(set) var googleEnabled = false

    // MARK: - Session Restore

    /// Check if we have a saved token and it's still valid
    func restoreSession() async -> Bool {
        guard KeychainHelper.loadToken() != nil else { return false }
        do {
            let user: LCUser = try await api.request("/lc/auth/me")
            currentUser = user
            isAuthenticated = true
            return true
        } catch {
            KeychainHelper.deleteToken()
            isAuthenticated = false
            return false
        }
    }

    // MARK: - Two-Step Email Auth

    /// Step 1: Check if email exists in PB
    func checkEmail(_ email: String) async throws -> Bool {
        struct Body: Encodable { let email: String }
        let resp: CheckEmailResponse = try await api.request(
            "/lc/auth/check-email",
            method: "POST",
            body: Body(email: email)
        )
        return resp.exists
    }

    /// Step 2a: Login with email + password
    func login(email: String, password: String) async throws -> LCUser {
        struct Body: Encodable { let email: String; let password: String }

        // Use rawRequest to capture Set-Cookie header
        let (data, response) = try await api.rawRequest(
            "/lc/auth/login",
            method: "POST",
            body: Body(email: email, password: password)
        )

        // Extract token from Set-Cookie
        if let token = await api.extractTokenFromResponse(response) {
            KeychainHelper.saveToken(token)
        }

        guard response.statusCode == 200 else {
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            let msg = json?["error"] as? String ?? "Login failed"
            throw APIError.serverError(response.statusCode, msg)
        }

        // Fetch full user profile
        let user: LCUser = try await api.request("/lc/auth/me")
        currentUser = user
        isAuthenticated = true
        return user
    }

    /// Step 2b: Register new account
    func register(name: String, email: String, password: String) async throws {
        struct Body: Encodable {
            let name: String; let email: String
            let password: String; let passwordConfirm: String
        }
        let _: SimpleResponse = try await api.request(
            "/lc/auth/register",
            method: "POST",
            body: Body(name: name, email: email, password: password, passwordConfirm: password)
        )
    }

    // MARK: - Google OAuth

    /// Check if Google OAuth is configured on the server
    func checkGoogleOAuth() async {
        struct MethodsResponse: Codable, Sendable {
            let google: Bool?
        }
        do {
            let resp: MethodsResponse = try await api.request("/lc/auth/methods")
            googleEnabled = resp.google ?? false
        } catch {
            googleEnabled = false
        }
    }

    /// Complete Google OAuth after receiving callback token
    func completeGoogleOAuth(token: String) async throws -> LCUser {
        KeychainHelper.saveToken(token)
        let user: LCUser = try await api.request("/lc/auth/me")
        currentUser = user
        isAuthenticated = true
        return user
    }

    /// Get the OAuth start URL
    func getGoogleOAuthURL() async -> URL? {
        let base = api.baseURL
        return URL(string: "\(base)/lc/auth/oauth-start?provider=google&redirect=lumichat://oauth-callback")
    }

    // MARK: - Token Refresh

    func refreshToken() async throws {
        let _: SimpleResponse = try await api.request("/lc/auth/refresh", method: "POST")
        // Server re-sets the cookie; we need to capture it
        // For simplicity, the cookie is already saved via the initial login
        // PB JWT doesn't change on refresh, just extends expiry
    }

    // MARK: - Logout

    func logout() async {
        let _: SimpleResponse? = try? await api.request("/lc/auth/logout", method: "POST")
        KeychainHelper.deleteToken()
        currentUser = nil
        isAuthenticated = false
    }

    // MARK: - Profile

    func fetchMe() async throws -> LCUser {
        let user: LCUser = try await api.request("/lc/auth/me")
        currentUser = user
        return user
    }

    func setUser(_ user: LCUser) {
        currentUser = user
        isAuthenticated = true
    }
}

// MARK: - OAuth Presentation Context

@MainActor
class OAuthPresentationContext: NSObject, ASWebAuthenticationPresentationContextProviding {
    static let shared = OAuthPresentationContext()

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap { $0.windows }
            .first(where: { $0.isKeyWindow }) ?? ASPresentationAnchor()
    }
}

