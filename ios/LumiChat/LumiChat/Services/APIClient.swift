import Foundation

enum APIError: Error, LocalizedError {
    case unauthorized
    case serverError(Int, String)
    case networkError(Error)
    case decodingError(Error)

    var errorDescription: String? {
        switch self {
        case .unauthorized: return "Not authenticated"
        case .serverError(let code, let msg): return "Server error \(code): \(msg)"
        case .networkError(let e): return e.localizedDescription
        case .decodingError(let e): return "Decoding: \(e.localizedDescription)"
        }
    }
}

actor APIClient {
    static let shared = APIClient()

    let baseURL: String

    private let session: URLSession
    private let decoder = JSONDecoder()

    init(baseURL: String = "https://lumigate.autorums.com") {
        self.baseURL = baseURL
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 30
        config.httpShouldSetCookies = false  // We manage cookies manually
        self.session = URLSession(configuration: config)
    }

    // MARK: - JSON Request

    func request<T: Decodable & Sendable>(
        _ path: String,
        method: String = "GET",
        body: (any Encodable)? = nil
    ) async throws -> T {
        var request = buildRequest(path, method: method)
        if let body {
            request.httpBody = try JSONEncoder().encode(body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }

        let (data, response) = try await session.data(for: request)
        try validateResponse(response, data: data)
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw APIError.decodingError(error)
        }
    }

    // MARK: - Raw Request (for non-JSON responses)

    func rawRequest(
        _ path: String,
        method: String = "GET",
        body: (any Encodable)? = nil
    ) async throws -> (Data, HTTPURLResponse) {
        var request = buildRequest(path, method: method)
        if let body {
            request.httpBody = try JSONEncoder().encode(body)
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }

        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw APIError.networkError(URLError(.badServerResponse))
        }
        return (data, http)
    }

    // MARK: - SSE Stream

    func streamRequest(
        _ path: String,
        body: any Encodable
    ) async throws -> (URLSession.AsyncBytes, HTTPURLResponse) {
        var request = buildRequest(path, method: "POST")
        request.httpBody = try JSONEncoder().encode(body)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 300 // 5 min for long generations

        let (bytes, response) = try await session.bytes(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw APIError.networkError(URLError(.badServerResponse))
        }
        if http.statusCode == 401 { throw APIError.unauthorized }
        if http.statusCode != 200 {
            // Read error body
            var errorBody = ""
            for try await line in bytes.lines { errorBody += line; break }
            throw APIError.serverError(http.statusCode, errorBody)
        }
        return (bytes, http)
    }

    // MARK: - Multipart Upload

    func upload<T: Decodable & Sendable>(
        _ path: String,
        fileData: Data,
        fileName: String,
        mimeType: String,
        fields: [String: String] = [:]
    ) async throws -> T {
        let boundary = "LumiChat-\(UUID().uuidString)"
        var body = Data()

        // Form fields
        for (key, value) in fields {
            body.append("--\(boundary)\r\n".data(using: .utf8)!)
            body.append("Content-Disposition: form-data; name=\"\(key)\"\r\n\r\n".data(using: .utf8)!)
            body.append("\(value)\r\n".data(using: .utf8)!)
        }

        // File
        body.append("--\(boundary)\r\n".data(using: .utf8)!)
        body.append("Content-Disposition: form-data; name=\"file\"; filename=\"\(fileName)\"\r\n".data(using: .utf8)!)
        body.append("Content-Type: \(mimeType)\r\n\r\n".data(using: .utf8)!)
        body.append(fileData)
        body.append("\r\n--\(boundary)--\r\n".data(using: .utf8)!)

        var request = buildRequest(path, method: "POST")
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        request.httpBody = body

        let (data, response) = try await session.data(for: request)
        try validateResponse(response, data: data)
        return try decoder.decode(T.self, from: data)
    }

    // MARK: - Helpers

    private func buildRequest(_ path: String, method: String) -> URLRequest {
        let url = URL(string: baseURL + path)!
        var request = URLRequest(url: url)
        request.httpMethod = method

        // Inject lc_token cookie
        if let token = KeychainHelper.loadToken() {
            request.setValue("lc_token=\(token)", forHTTPHeaderField: "Cookie")
        }

        return request
    }

    private func validateResponse(_ response: URLResponse, data: Data) throws {
        guard let http = response as? HTTPURLResponse else {
            throw APIError.networkError(URLError(.badServerResponse))
        }
        if http.statusCode == 401 {
            throw APIError.unauthorized
        }
        if http.statusCode >= 400 {
            let body = String(data: data, encoding: .utf8) ?? ""
            // Try to extract error message from JSON
            if let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let msg = json["error"] as? String {
                throw APIError.serverError(http.statusCode, msg)
            }
            throw APIError.serverError(http.statusCode, body.prefix(200).description)
        }
    }

    // MARK: - Cookie Extraction (for OAuth)

    /// Extract lc_token from Set-Cookie headers after login
    func extractTokenFromResponse(_ response: HTTPURLResponse) -> String? {
        guard let headers = response.allHeaderFields as? [String: String],
              let url = response.url else { return nil }

        let cookies = HTTPCookie.cookies(withResponseHeaderFields: headers, for: url)
        return cookies.first(where: { $0.name == "lc_token" })?.value
    }
}
