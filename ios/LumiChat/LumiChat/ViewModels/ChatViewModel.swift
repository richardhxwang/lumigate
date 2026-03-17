import SwiftUI
import UIKit

private struct ChatMsgTuple: Sendable {
    let role: String
    let content: String
}

@MainActor
@Observable
class ChatViewModel {
    var messages: [ChatMessage] = []
    var isStreaming = false
    var streamingText = ""
    var isSearching = false
    var searchQuery = ""
    var usageInfo: (input: Int, output: Int)?
    var isThinking = false
    var errorMessage: String?

    var currentSessionId: String?
    var selectedProvider = "minimax"
    var selectedModel = "MiniMax-M2.5"
    var webSearchEnabled = false
    var activeProject: Project?
    var pendingImages: [UIImage] = []
    var isUploading = false
    var onSessionCreated: ((ChatSession) -> Void)?
    var onSessionUpdated: ((String, String) -> Void)?

    private let chatService = ChatService.shared
    private let sessionService = SessionService.shared
    private let settingsService = SettingsService.shared
    private let fileService = FileService.shared
    private var streamTask: Task<Void, Never>?
    private var lastHapticTime: Date = .distantPast
    private let hapticInterval: TimeInterval = 0.08  // ~12 Hz, like GPT app

    // MARK: - Send Message

    func sendMessage(_ text: String) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        // Create session if needed
        if currentSessionId == nil {
            do {
                let sess = try await sessionService.createSession(
                    title: String(trimmed.prefix(50)),
                    provider: selectedProvider,
                    model: selectedModel
                )
                currentSessionId = sess.id
                onSessionCreated?(sess)
            } catch {
                errorMessage = error.localizedDescription
                return
            }
        }

        // Save user message to PB
        do {
            let userMsg = try await sessionService.createMessage(
                session: currentSessionId!,
                role: "user",
                content: trimmed
            )
            messages.append(userMsg)
        } catch {
            errorMessage = error.localizedDescription
            return
        }

        // Start streaming
        await streamResponse()
    }

    // MARK: - Stream AI Response

    private func streamResponse() {
        isStreaming = true
        streamingText = ""
        isSearching = false
        usageInfo = nil
        isThinking = ChatService.isThinkingModel(selectedModel)
        errorMessage = nil

        // Capture state for Task
        let capturedMessages: [ChatMsgTuple] = messages.suffix(40).map {
            ChatMsgTuple(role: $0.role, content: $0.content)
        }
        let capturedProvider = selectedProvider
        let capturedModel = selectedModel
        let capturedUseTools = webSearchEnabled
        let capturedProject = activeProject

        streamTask = Task {
            // Upload pending images
            let imageParts = await uploadPendingImages()

            // Build messages for AI
            nonisolated(unsafe) var aiMsgs: [[String: Any]] = capturedMessages.map { msg in
                ["role": msg.role, "content": msg.content] as [String: Any]
            }
            // Attach images to last user message if any
            if !imageParts.isEmpty, var lastMsg = aiMsgs.last, lastMsg["role"] as? String == "user" {
                let textPart: [String: Any] = ["type": "text", "text": lastMsg["content"] as? String ?? ""]
                lastMsg["content"] = [textPart] + imageParts
                aiMsgs[aiMsgs.count - 1] = lastMsg
            }
            do {
                let stream = await chatService.streamChat(
                    provider: capturedProvider,
                    model: capturedModel,
                    messages: aiMsgs,
                    systemPrompt: await settingsService.getActiveSystemPrompt(activeProject: capturedProject),
                    useTools: capturedUseTools
                )

                // First token haptic
                var gotFirstToken = false

                for try await event in stream {
                    switch event {
                    case .text(let delta):
                        isThinking = false
                        streamingText += delta

                        // Haptic feedback: burst on first token, then throttled ticks
                        if !gotFirstToken {
                            gotFirstToken = true
                            Haptics.impact()
                        } else {
                            let now = Date()
                            if now.timeIntervalSince(lastHapticTime) >= hapticInterval {
                                lastHapticTime = now
                                Haptics.tap()
                            }
                        }

                    case .searching(let query):
                        isSearching = true
                        searchQuery = query
                        Haptics.select()
                    case .usage(let inp, let out):
                        usageInfo = (inp, out)
                    }
                }

                // Stream complete haptic
                Haptics.success()

                // Save assistant message to PB
                if !streamingText.isEmpty, let sid = currentSessionId {
                    let asstMsg = try await sessionService.createMessage(
                        session: sid,
                        role: "assistant",
                        content: streamingText
                    )
                    messages.append(asstMsg)

                    // Auto-title: if this is the first exchange, generate a title
                    if messages.count <= 2 {
                        let title = generateTitle(from: streamingText)
                        try? await sessionService.renameSession(sid, title: title)
                        onSessionUpdated?(sid, title)
                    }
                }
            } catch is CancellationError {
                // User interrupted — save partial
                if !streamingText.isEmpty, let sid = currentSessionId {
                    let partial = try? await sessionService.createMessage(
                        session: sid,
                        role: "assistant",
                        content: streamingText
                    )
                    if let p = partial { messages.append(p) }
                }
            } catch {
                errorMessage = error.localizedDescription
                Haptics.error()
            }

            isStreaming = false
            isSearching = false
            isThinking = false
            streamingText = ""
        }
    }

    // MARK: - Stop

    func stopStreaming() {
        streamTask?.cancel()
        streamTask = nil
    }

    // MARK: - Load Session

    func loadSession(_ session: ChatSession) async {
        currentSessionId = session.id
        selectedProvider = session.provider ?? selectedProvider
        selectedModel = session.model ?? selectedModel
        do {
            messages = try await sessionService.loadMessages(sessionId: session.id)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    // MARK: - New Chat

    func newChat() {
        currentSessionId = nil
        messages = []
        streamingText = ""
        isStreaming = false
        errorMessage = nil
    }

    // MARK: - Delete Message

    func deleteMessage(_ id: String) async {
        try? await sessionService.deleteMessage(id)
        messages.removeAll { $0.id == id }
    }

    // MARK: - Edit & Resend

    func editAndResend(_ messageId: String, newContent: String) async {
        // Remove original and all messages after it
        if let idx = messages.firstIndex(where: { $0.id == messageId }) {
            let toDelete = messages[idx...]
            for msg in toDelete {
                try? await sessionService.deleteMessage(msg.id)
            }
            messages.removeSubrange(idx...)
        }
        // Send the edited message
        await sendMessage(newContent)
    }

    func resendLastUser() async {
        guard let lastUser = messages.last(where: { $0.role == "user" }) else { return }
        // Remove the last assistant response if any
        if let lastMsg = messages.last, lastMsg.role == "assistant" {
            try? await sessionService.deleteMessage(lastMsg.id)
            messages.removeLast()
        }
        await streamResponse()
    }

    // MARK: - Attachments

    func addImage(_ image: UIImage) {
        pendingImages.append(image)
        Haptics.select()
    }

    func removeImage(at index: Int) {
        guard pendingImages.indices.contains(index) else { return }
        pendingImages.remove(at: index)
    }

    /// Generate a short title from the AI's first response
    private func generateTitle(from text: String) -> String {
        // Take first sentence or first 50 chars
        let cleaned = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let sentenceEnders: [Character] = [".", "!", "?", "\n", "。", "！", "？"]
        if let endIdx = cleaned.firstIndex(where: { sentenceEnders.contains($0) }) {
            let sentence = String(cleaned[cleaned.startIndex...endIdx])
            if sentence.count <= 60 { return sentence }
        }
        if cleaned.count <= 50 { return cleaned }
        let prefix = String(cleaned.prefix(47))
        return prefix + "..."
    }

    /// Upload pending images and return base64 content parts for vision models
    private func uploadPendingImages() async -> [[String: Any]] {
        guard !pendingImages.isEmpty else { return [] }
        isUploading = true
        defer { isUploading = false; pendingImages = [] }

        var parts: [[String: Any]] = []
        for image in pendingImages {
            let resized = await fileService.prepareImage(image)
            if let data = resized.jpegData(compressionQuality: 0.8) {
                let base64 = data.base64EncodedString()
                parts.append([
                    "type": "image_url",
                    "image_url": ["url": "data:image/jpeg;base64,\(base64)"]
                ])
            }
        }
        return parts
    }
}
