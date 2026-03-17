import SwiftUI

// MARK: - Design Tokens (from LumiChat web CSS)

enum LCColor {
    // Accent
    static let accent = Color(hex: "#10a37f")
    static let accentDark = Color(hex: "#0d9268")

    // Semantic
    static let green = Color(hex: "#34c759")
    static let red = Color(hex: "#ff3b30")
    static let orange = Color(hex: "#ff9500")

    // Dark mode
    enum Dark {
        static let bg = Color(hex: "#000000")
        static let sb = Color(hex: "#000000")
        static let sbHover = Color(hex: "#141414")
        static let sbActive = Color(hex: "#1e1e1e")
        static let inp = Color(hex: "#1a1a1a")
        static let inpBorder = Color(hex: "#2e2e2e")
        static let inpBorderHover = Color(hex: "#484848")
        static let t1 = Color(hex: "#ececec")
        static let t2 = Color(hex: "#8e8e8e")
        static let t3 = Color(hex: "#505050")
        static let userBg = Color(hex: "#1a1a1a")
        static let border = Color(hex: "#222222")
        static let codeBg = Color(hex: "#0d0d0d")
    }

    // Light mode
    enum Light {
        static let bg = Color(hex: "#ffffff")
        static let sb = Color(hex: "#f7f7f8")
        static let sbHover = Color(hex: "#ececec")
        static let sbActive = Color(hex: "#e2e2e2")
        static let inp = Color(hex: "#f4f4f5")
        static let inpBorder = Color(hex: "#d9d9d9")
        static let inpBorderHover = Color(hex: "#a0a0a0")
        static let t1 = Color(hex: "#0d0d0d")
        static let t2 = Color(hex: "#555555")
        static let t3 = Color(hex: "#999999")
        static let userBg = Color(hex: "#f0f0f0")
        static let border = Color(hex: "#e5e5e5")
        static let codeBg = Color(hex: "#f6f6f7")
    }
}

// MARK: - Border Radius

enum LCRadius {
    static let r1: CGFloat = 8    // chips, tags, small buttons
    static let r2: CGFloat = 12   // inputs, cards
    static let r3: CGFloat = 16   // dropdowns, panels
    static let r4: CGFloat = 20   // sheets
    static let r5: CGFloat = 26   // large modals
}

// MARK: - Layout

enum LCLayout {
    static let sidebarWidth: CGFloat = 260
    static let headerHeight: CGFloat = 52
    static let maxChatWidth: CGFloat = 768
    static let maxAuthWidth: CGFloat = 400
}

// MARK: - Typography

enum LCFont {
    static func body(_ size: CGFloat = 15) -> Font { .system(size: size) }
    static func medium(_ size: CGFloat = 15) -> Font { .system(size: size, weight: .medium) }
    static func semibold(_ size: CGFloat = 15) -> Font { .system(size: size, weight: .semibold) }
    static func bold(_ size: CGFloat = 15) -> Font { .system(size: size, weight: .bold) }
    static func mono(_ size: CGFloat = 13) -> Font { .system(size: size, design: .monospaced) }
    static func monoSemibold(_ size: CGFloat = 13) -> Font { .system(size: size, weight: .semibold, design: .monospaced) }
}

// MARK: - Color(hex:) Extension

extension Color {
    init(hex: String) {
        let hex = hex.trimmingCharacters(in: .init(charactersIn: "#"))
        let scanner = Scanner(string: hex)
        var rgb: UInt64 = 0
        scanner.scanHexInt64(&rgb)
        self.init(
            red: Double((rgb >> 16) & 0xFF) / 255,
            green: Double((rgb >> 8) & 0xFF) / 255,
            blue: Double(rgb & 0xFF) / 255
        )
    }
}

// MARK: - Environment-Aware Colors

struct LCColors {
    let colorScheme: ColorScheme

    var bg: Color { colorScheme == .dark ? LCColor.Dark.bg : LCColor.Light.bg }
    var sb: Color { colorScheme == .dark ? LCColor.Dark.sb : LCColor.Light.sb }
    var sbHover: Color { colorScheme == .dark ? LCColor.Dark.sbHover : LCColor.Light.sbHover }
    var sbActive: Color { colorScheme == .dark ? LCColor.Dark.sbActive : LCColor.Light.sbActive }
    var inp: Color { colorScheme == .dark ? LCColor.Dark.inp : LCColor.Light.inp }
    var inpBorder: Color { colorScheme == .dark ? LCColor.Dark.inpBorder : LCColor.Light.inpBorder }
    var t1: Color { colorScheme == .dark ? LCColor.Dark.t1 : LCColor.Light.t1 }
    var t2: Color { colorScheme == .dark ? LCColor.Dark.t2 : LCColor.Light.t2 }
    var t3: Color { colorScheme == .dark ? LCColor.Dark.t3 : LCColor.Light.t3 }
    var userBg: Color { colorScheme == .dark ? LCColor.Dark.userBg : LCColor.Light.userBg }
    var border: Color { colorScheme == .dark ? LCColor.Dark.border : LCColor.Light.border }
    var codeBg: Color { colorScheme == .dark ? LCColor.Dark.codeBg : LCColor.Light.codeBg }
}
