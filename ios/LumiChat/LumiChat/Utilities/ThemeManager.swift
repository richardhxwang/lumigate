import SwiftUI

@MainActor
@Observable
class ThemeManager {
    static let shared = ThemeManager()

    var preference: ThemePreference = .auto {
        didSet { save() }
    }

    var preferredColorScheme: ColorScheme? {
        switch preference {
        case .auto: nil
        case .light: .light
        case .dark: .dark
        }
    }

    init() {
        if let raw = UserDefaults.standard.string(forKey: "lc_theme"),
           let pref = ThemePreference(rawValue: raw) {
            preference = pref
        }
    }

    private func save() {
        UserDefaults.standard.set(preference.rawValue, forKey: "lc_theme")
    }
}

enum ThemePreference: String, CaseIterable {
    case auto, light, dark

    var label: String {
        switch self {
        case .auto: "Auto"
        case .light: "Light"
        case .dark: "Dark"
        }
    }

    var icon: String {
        switch self {
        case .auto: "circle.lefthalf.filled"
        case .light: "sun.max"
        case .dark: "moon"
        }
    }
}
