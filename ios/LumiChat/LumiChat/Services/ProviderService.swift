import Foundation

actor ProviderService {
    static let shared = ProviderService()
    private let api = APIClient.shared

    private var cachedProviders: [ProviderInfo] = []
    private var cachedModels: [String: [ModelInfo]] = [:]

    func loadProviders() async throws -> [ProviderInfo] {
        if !cachedProviders.isEmpty { return cachedProviders }
        let resp: ProvidersResponse = try await api.request("/providers")
        cachedProviders = resp.providers
        return cachedProviders
    }

    func loadModels(provider: String) async throws -> [ModelInfo] {
        if let cached = cachedModels[provider] { return cached }
        let resp: ModelsResponse = try await api.request("/v1/\(provider)/v1/models")
        cachedModels[provider] = resp.data
        return resp.data
    }

    func invalidateCache() {
        cachedProviders = []
        cachedModels = [:]
    }
}

private struct ProvidersResponse: Codable, Sendable {
    let providers: [ProviderInfo]
}

private struct ModelsResponse: Codable, Sendable {
    let data: [ModelInfo]
}
