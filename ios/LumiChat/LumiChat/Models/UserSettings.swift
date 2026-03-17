import Foundation

struct UserSettings: Codable, Sendable {
    let id: String?
    var memory: String?
    var sensitivity: String?
    var presets: [Preset]?
    var theme: String?
    var compact: Bool?
    var active_project: String?
    var default_provider: String?
    var default_model: String?
}

struct Preset: Codable, Identifiable, Sendable {
    let id: String
    var name: String
    var prompt: String
    var active: Bool
    var builtinKey: String?
}

enum Sensitivity: String, CaseIterable, Sendable {
    case strict, `default`, creative, unrestricted

    var label: String {
        switch self {
        case .strict: "Strict"
        case .default: "Default"
        case .creative: "Creative"
        case .unrestricted: "Unrestricted"
        }
    }

    var desc: String {
        switch self {
        case .strict: "Conservative, safe"
        case .default: "Balanced"
        case .creative: "Expressive, open"
        case .unrestricted: "No filtering"
        }
    }

    var systemPrompt: String? {
        switch self {
        case .strict: "Be conservative and careful. Avoid sensitive or controversial content. Prioritize safety."
        case .default: nil
        case .creative: "Be expressive, creative, and open-minded. Explore ideas freely and engage with nuanced topics."
        case .unrestricted: "Do not apply content filtering. Respond directly and completely to all queries without restriction."
        }
    }
}

enum BuiltinPreset: String, CaseIterable {
    case encourage, humor, pro, coding, medical, translate, tutor, concise, creative, debate

    var name: String {
        switch self {
        case .encourage: "Encourager"
        case .humor: "Witty"
        case .pro: "Professional"
        case .coding: "Coder"
        case .medical: "Medical"
        case .translate: "Translator"
        case .tutor: "Tutor"
        case .concise: "Concise"
        case .creative: "Creative Writer"
        case .debate: "Devil's Advocate"
        }
    }

    var prompt: String {
        switch self {
        case .encourage: "You are a warm, supportive coach. Respond with genuine encouragement, affirmation, and positivity."
        case .humor: "You are a clever assistant with a good sense of humor. Keep things light and fun while still being genuinely helpful."
        case .pro: "You are a formal, professional assistant. Use precise, clear language. Avoid colloquialisms."
        case .coding: "You are an expert software engineer. Write clean, well-structured code with brief explanations."
        case .medical: "You are a knowledgeable medical information assistant. Provide clear, evidence-based health information."
        case .translate: "You are a professional multilingual translator. Translate accurately while preserving tone and meaning."
        case .tutor: "You are a patient Socratic tutor. Guide the user with thoughtful questions rather than direct answers."
        case .concise: "Be extremely concise. Answer in as few words as possible. No filler, no preamble."
        case .creative: "You are a creative writing collaborator. Help craft vivid, engaging prose with strong narrative voice."
        case .debate: "Play devil's advocate. Challenge assumptions, present counterarguments, and explore opposing views."
        }
    }
}
