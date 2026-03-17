import Foundation
import Security

enum KeychainHelper {
    private static let service = "com.lumichat.auth"
    private static let tokenAccount = "lc_token"

    // MARK: - Token Convenience

    static func saveToken(_ token: String) {
        guard let data = token.data(using: .utf8) else { return }
        save(key: tokenAccount, data: data)
    }

    static func loadToken() -> String? {
        guard let data = load(key: tokenAccount) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func deleteToken() {
        delete(key: tokenAccount)
    }

    // MARK: - Generic CRUD

    @discardableResult
    static func save(key: String, data: Data) -> Bool {
        delete(key: key) // Remove existing before saving

        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlock,
        ]
        let status = SecItemAdd(query as CFDictionary, nil)
        return status == errSecSuccess
    }

    static func load(key: String) -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess else { return nil }
        return result as? Data
    }

    @discardableResult
    static func delete(key: String) -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        let status = SecItemDelete(query as CFDictionary)
        return status == errSecSuccess || status == errSecItemNotFound
    }
}
