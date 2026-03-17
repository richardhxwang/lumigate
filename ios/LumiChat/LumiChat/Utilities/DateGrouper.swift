import Foundation

enum DateGrouper {
    struct Group<T> {
        let label: String
        let items: [T]
    }

    /// Groups sessions by date: Today / Yesterday / Past 7 Days / Older
    static func group(_ sessions: [ChatSession]) -> [Group<ChatSession>] {
        let cal = Calendar.current
        let now = Date()
        let todayStart = cal.startOfDay(for: now)
        let yesterdayStart = cal.date(byAdding: .day, value: -1, to: todayStart)!
        let weekStart = cal.date(byAdding: .day, value: -7, to: todayStart)!

        var today: [ChatSession] = []
        var yesterday: [ChatSession] = []
        var week: [ChatSession] = []
        var older: [ChatSession] = []

        for s in sessions {
            let date = parseDate(s.updated ?? s.created ?? "") ?? .distantPast
            if date >= todayStart { today.append(s) }
            else if date >= yesterdayStart { yesterday.append(s) }
            else if date >= weekStart { week.append(s) }
            else { older.append(s) }
        }

        var result: [Group<ChatSession>] = []
        if !today.isEmpty { result.append(Group(label: "Today", items: today)) }
        if !yesterday.isEmpty { result.append(Group(label: "Yesterday", items: yesterday)) }
        if !week.isEmpty { result.append(Group(label: "Past 7 Days", items: week)) }
        if !older.isEmpty { result.append(Group(label: "Older", items: older)) }
        return result
    }

    private static func parseDate(_ iso: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
    }
}
