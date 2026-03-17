import Foundation

/// Parses Server-Sent Events from URLSession.AsyncBytes
enum SSEParser {

    /// Parse SSE stream into a sequence of delta events
    static func parse(
        bytes: URLSession.AsyncBytes
    ) -> AsyncThrowingStream<SSEDelta, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                var buffer = ""
                do {
                    for try await byte in bytes {
                        let char = Character(UnicodeScalar(byte))
                        buffer.append(char)

                        // Process complete lines
                        while let newlineRange = buffer.range(of: "\n") {
                            let line = String(buffer[buffer.startIndex..<newlineRange.lowerBound])
                            buffer = String(buffer[newlineRange.upperBound...])

                            guard line.hasPrefix("data: ") else { continue }
                            let data = String(line.dropFirst(6)).trimmingCharacters(in: .whitespaces)

                            if data == "[DONE]" {
                                continuation.finish()
                                return
                            }

                            guard let jsonData = data.data(using: .utf8) else { continue }
                            do {
                                let delta = try JSONDecoder().decode(SSEDelta.self, from: jsonData)
                                continuation.yield(delta)
                            } catch {
                                // Skip malformed chunks (same as web app's try/catch{})
                                continue
                            }
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}
