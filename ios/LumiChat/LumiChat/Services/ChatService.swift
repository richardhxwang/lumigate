import Foundation

/// Handles sending messages and streaming AI responses
actor ChatService {
    static let shared = ChatService()
    private let api = APIClient.shared
    private let sessions = SessionService.shared

    /// O-series and reasoning models that show "Thinking" indicator
    private static let thinkingModels: Set<String> = ["o1", "o1-mini", "o1-preview", "o3", "o3-mini", "o4-mini"]

    static func isThinkingModel(_ id: String) -> Bool {
        if thinkingModels.contains(id) { return true }
        let l = id.lowercased()
        return l.contains("reasoner") || l.contains("think") || l.contains("qwq") || l.contains("r1")
    }

    /// Providers that support tool_calls (web search)
    private static let toolProviders: Set<String> = ["openai", "deepseek", "qwen", "kimi", "doubao", "anthropic"]

    static func supportsTools(_ provider: String) -> Bool {
        toolProviders.contains(provider)
    }

    // MARK: - Streaming Chat

    /// Stream a chat response. Returns an AsyncStream of text deltas.
    func streamChat(
        provider: String,
        model: String,
        messages: [[String: Any]],
        systemPrompt: String?,
        useTools: Bool
    ) -> AsyncThrowingStream<StreamEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    // Build messages array
                    var aiMsgs: [[String: AnyCodable]] = []

                    // System prompt
                    if let sys = systemPrompt, !sys.isEmpty {
                        aiMsgs.append(["role": AnyCodable("system"), "content": AnyCodable(sys)])
                    }

                    // User/assistant messages
                    for msg in messages {
                        var m: [String: AnyCodable] = [:]
                        for (k, v) in msg { m[k] = AnyCodable(v) }
                        aiMsgs.append(m)
                    }

                    // Build payload
                    var payload = ChatPayload(
                        model: model,
                        messages: aiMsgs,
                        stream: true,
                        stream_options: StreamOptions(include_usage: true)
                    )

                    // O-series uses max_completion_tokens
                    if Self.thinkingModels.contains(model) {
                        payload.max_completion_tokens = 4096
                    } else {
                        payload.max_tokens = 4096
                    }

                    // Web search tool
                    if useTools && Self.supportsTools(provider) {
                        payload.tools = [AnyCodable([
                            "type": "function",
                            "function": [
                                "name": "web_search",
                                "description": "Search the web for current information",
                                "parameters": [
                                    "type": "object",
                                    "properties": ["query": ["type": "string", "description": "Search query"]],
                                    "required": ["query"]
                                ]
                            ] as [String: Any]
                        ])]
                        payload.tool_choice = "auto"
                    }

                    // Agentic loop (max 4 rounds for tool calls)
                    var loopMessages = aiMsgs
                    for toolRound in 0..<4 {
                        var loopPayload = payload
                        loopPayload.messages = loopMessages
                        if toolRound > 0 {
                            loopPayload.tools = nil
                            loopPayload.tool_choice = nil
                        }

                        let endpoint = "/v1/\(provider)/v1/chat/completions"
                        let (bytes, _) = try await api.streamRequest(endpoint, body: loopPayload)

                        // Parse SSE
                        var fullText = ""
                        var accToolCalls: [Int: (id: String, name: String, args: String)] = [:]
                        var finishReason = ""
                        var usage: SSEUsage?

                        for try await delta in SSEParser.parse(bytes: bytes) {
                            if let u = delta.usage { usage = u }
                            guard let choice = delta.choices?.first else { continue }
                            if let fr = choice.finish_reason { finishReason = fr }

                            // Accumulate tool calls
                            if let tcs = choice.delta?.tool_calls {
                                for tc in tcs {
                                    let idx = tc.index ?? 0
                                    if accToolCalls[idx] == nil { accToolCalls[idx] = ("", "", "") }
                                    if let id = tc.id { accToolCalls[idx]!.id = id }
                                    if let name = tc.function?.name { accToolCalls[idx]!.name = name }
                                    if let args = tc.function?.arguments { accToolCalls[idx]!.args += args }
                                }
                            }

                            // Stream content
                            if let content = choice.delta?.content, !content.isEmpty {
                                fullText += content
                                continuation.yield(.text(content))
                            }
                        }

                        // Tool call detected — execute and loop
                        if finishReason == "tool_calls" && !accToolCalls.isEmpty {
                            // Add assistant tool_calls message
                            let tcList = accToolCalls.values.map { tc -> [String: Any] in
                                ["id": tc.id.isEmpty ? "call_\(UUID().uuidString.prefix(8))" : tc.id,
                                 "type": "function",
                                 "function": ["name": tc.name, "arguments": tc.args] as [String: Any]]
                            }
                            loopMessages.append(["role": AnyCodable("assistant"), "content": AnyCodable(NSNull()), "tool_calls": AnyCodable(tcList)])

                            // Execute each tool call
                            for tc in accToolCalls.values {
                                continuation.yield(.searching(tc.args))
                                let result = await executeSearch(query: tc.args)
                                let toolId = tc.id.isEmpty ? "call_\(UUID().uuidString.prefix(8))" : tc.id
                                loopMessages.append(["role": AnyCodable("tool"), "tool_call_id": AnyCodable(toolId), "content": AnyCodable(result)])
                            }
                            continue // Next loop iteration
                        }

                        // Normal completion
                        if let u = usage {
                            continuation.yield(.usage(inputTokens: u.prompt_tokens ?? 0, outputTokens: u.completion_tokens ?? 0))
                        }
                        break
                    }

                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    // MARK: - Web Search

    private func executeSearch(query: String) async -> String {
        // Parse query from JSON args
        var q = query
        if let data = query.data(using: .utf8),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let parsed = json["query"] as? String {
            q = parsed
        }

        do {
            struct SearchResult: Codable {
                let query: String?
                let results: [SearchItem]?
            }
            struct SearchItem: Codable {
                let title: String?
                let url: String?
                let content: String?
            }
            let result: SearchResult = try await api.request("/lc/search?q=\(q.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? q)")
            let formatted = (result.results ?? []).enumerated().map { i, r in
                "[\(i+1)] \(r.title ?? "")\nURL: \(r.url ?? "")\n\(r.content ?? "")"
            }.joined(separator: "\n\n")
            return "Search results for \"\(q)\":\n\n\(formatted)"
        } catch {
            return "Search failed: \(error.localizedDescription)"
        }
    }
}

// MARK: - Stream Events

enum StreamEvent: Sendable {
    case text(String)
    case searching(String)
    case usage(inputTokens: Int, outputTokens: Int)
}
