import SwiftUI
import AuthenticationServices

struct AuthView: View {
    @Environment(AppState.self) private var appState
    @State private var step: AuthStep = .email
    @State private var email = ""
    @State private var password = ""
    @State private var confirmPassword = ""
    @State private var name = ""
    @State private var errorMessage = ""
    @State private var isLoading = false
    @State private var googleEnabled = false
    @State private var hasSubmitted = false

    enum AuthStep {
        case email, login, register
    }

    var body: some View {
        ZStack {
            Color(.systemBackground)
                .ignoresSafeArea()

            VStack(spacing: 0) {
                Spacer()

                // Logo
                VStack(spacing: 12) {
                    LumiChatLogo(size: 56)
                    Text("LumiChat")
                        .font(LCFont.bold(28))
                }
                .padding(.bottom, 32)

                // Form
                VStack(spacing: 12) {
                    switch step {
                    case .email:
                        emailStep
                    case .login:
                        loginStep
                    case .register:
                        registerStep
                    }
                }
                .frame(maxWidth: LCLayout.maxAuthWidth)
                .padding(.horizontal, 24)

                // Error — only show after user has submitted
                Text(hasSubmitted && !errorMessage.isEmpty ? errorMessage : " ")
                    .font(LCFont.body(12))
                    .foregroundStyle(LCColor.red)
                    .padding(.top, 10)
                    .opacity(hasSubmitted && !errorMessage.isEmpty ? 1 : 0)
                    .animation(.easeInOut(duration: 0.2), value: errorMessage)

                Spacer()
                Spacer()
            }
        }
    }

    // MARK: - Steps

    private var emailStep: some View {
        VStack(spacing: 12) {
            Text("Welcome")
                .font(LCFont.bold(22))
            Text("Log in or create an account")
                .font(LCFont.body(14))
                .foregroundStyle(.secondary)
                .padding(.bottom, 8)

            // Google OAuth
            if googleEnabled {
                GoogleSignInButton(isLoading: isLoading) {
                    doGoogleLogin()
                }

                // Divider
                HStack {
                    Rectangle().fill(Color.secondary.opacity(0.3)).frame(height: 1)
                    Text("or")
                        .font(LCFont.body(13))
                        .foregroundStyle(.secondary)
                    Rectangle().fill(Color.secondary.opacity(0.3)).frame(height: 1)
                }
                .padding(.vertical, 4)
            }

            AuthTextField(text: $email, placeholder: "Email", keyboardType: .emailAddress)
                .onSubmit { checkEmail() }

            AuthButton(title: "Continue", isLoading: isLoading) {
                checkEmail()
            }
        }
        .task {
            await AuthService.shared.checkGoogleOAuth()
            googleEnabled = await AuthService.shared.googleEnabled
        }
    }

    private var loginStep: some View {
        VStack(spacing: 12) {
            Text("Welcome back")
                .font(LCFont.bold(22))
            Text(email)
                .font(LCFont.body(14))
                .foregroundStyle(.secondary)
                .padding(.bottom, 8)

            AuthTextField(text: $password, placeholder: "Password", isSecure: true)
                .onSubmit { doLogin() }

            AuthButton(title: "Continue", isLoading: isLoading) {
                doLogin()
            }

            if googleEnabled {
                GoogleSignInButton(isLoading: isLoading) {
                    doGoogleLogin()
                }
            }

            Button("Use a different email") {
                withAnimation(.spring(duration: 0.3)) {
                    step = .email
                    errorMessage = ""
                    hasSubmitted = false
                }
            }
            .font(LCFont.medium(13))
            .foregroundStyle(LCColor.accent)
        }
    }

    private var registerStep: some View {
        VStack(spacing: 12) {
            Text("Create account")
                .font(LCFont.bold(22))
            Text(email)
                .font(LCFont.body(14))
                .foregroundStyle(.secondary)
                .padding(.bottom, 8)

            AuthTextField(text: $name, placeholder: "Display name")
            AuthTextField(text: $password, placeholder: "Password (min. 8 characters)", isSecure: true)
            AuthTextField(text: $confirmPassword, placeholder: "Confirm password", isSecure: true)
                .onSubmit { doRegister() }

            AuthButton(title: "Create account", isLoading: isLoading) {
                doRegister()
            }

            Button("Use a different email") {
                withAnimation(.spring(duration: 0.3)) {
                    step = .email
                    errorMessage = ""
                    hasSubmitted = false
                }
            }
            .font(LCFont.medium(13))
            .foregroundStyle(LCColor.accent)
        }
    }

    // MARK: - Actions

    private func doGoogleLogin() {
        isLoading = true
        errorMessage = ""
        Task {
            do {
                guard let startURL = await AuthService.shared.getGoogleOAuthURL() else {
                    errorMessage = "Google OAuth not configured"
                    isLoading = false
                    return
                }

                let callbackURL: URL = try await withCheckedThrowingContinuation { cont in
                    let session = ASWebAuthenticationSession(
                        url: startURL,
                        callbackURLScheme: "lumichat"
                    ) { url, error in
                        if let error {
                            cont.resume(throwing: error)
                        } else if let url {
                            cont.resume(returning: url)
                        } else {
                            cont.resume(throwing: URLError(.cancelled))
                        }
                    }
                    session.presentationContextProvider = OAuthPresentationContext.shared
                    session.prefersEphemeralWebBrowserSession = false
                    session.start()
                }

                guard let components = URLComponents(url: callbackURL, resolvingAgainstBaseURL: false),
                      let token = components.queryItems?.first(where: { $0.name == "token" })?.value else {
                    errorMessage = "No token received"
                    isLoading = false
                    return
                }

                let user = try await AuthService.shared.completeGoogleOAuth(token: token)
                appState.onLoginSuccess(user)
            } catch {
                if (error as NSError).code != 1 {
                    errorMessage = error.localizedDescription
                }
            }
            isLoading = false
        }
    }

    private func checkEmail() {
        hasSubmitted = true
        guard !email.isEmpty, email.contains("@") else {
            errorMessage = "Enter a valid email"
            return
        }
        isLoading = true
        errorMessage = ""
        Task {
            do {
                let exists = try await AuthService.shared.checkEmail(email)
                withAnimation(.spring(duration: 0.3)) {
                    step = exists ? .login : .register
                }
            } catch {
                errorMessage = error.localizedDescription
            }
            isLoading = false
        }
    }

    private func doLogin() {
        hasSubmitted = true
        guard !password.isEmpty else {
            errorMessage = "Enter your password"
            return
        }
        isLoading = true
        errorMessage = ""
        Task {
            do {
                let user = try await AuthService.shared.login(email: email, password: password)
                appState.onLoginSuccess(user)
            } catch {
                errorMessage = error.localizedDescription
            }
            isLoading = false
        }
    }

    private func doRegister() {
        hasSubmitted = true
        guard password.count >= 8 else {
            errorMessage = "Password must be at least 8 characters"
            return
        }
        guard password == confirmPassword else {
            errorMessage = "Passwords don't match"
            return
        }
        isLoading = true
        errorMessage = ""
        Task {
            do {
                try await AuthService.shared.register(name: name, email: email, password: password)
                // Auto-login after registration
                let user = try await AuthService.shared.login(email: email, password: password)
                appState.onLoginSuccess(user)
            } catch {
                errorMessage = error.localizedDescription
            }
            isLoading = false
        }
    }
}

// MARK: - Reusable Components

struct AuthTextField: View {
    @Binding var text: String
    let placeholder: String
    var isSecure = false
    var keyboardType: UIKeyboardType = .default

    var body: some View {
        Group {
            if isSecure {
                SecureField(placeholder, text: $text)
            } else {
                TextField(placeholder, text: $text)
                    .keyboardType(keyboardType)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }
        }
        .padding(14)
        .background(.quaternary.opacity(0.5))
        .clipShape(RoundedRectangle(cornerRadius: LCRadius.r2))
        .font(LCFont.body(15))
    }
}

struct GoogleSignInButton: View {
    var isLoading: Bool = false
    let action: () -> Void
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                GoogleGIcon()
                    .frame(width: 18, height: 18)
                Text("Continue with Google")
                    .font(LCFont.medium(15))
                    .foregroundStyle(.primary)
            }
            .frame(maxWidth: .infinity)
            .frame(height: 48)
            .background(colorScheme == .dark ? Color.white.opacity(0.08) : .white)
            .clipShape(RoundedRectangle(cornerRadius: LCRadius.r2))
            .overlay(
                RoundedRectangle(cornerRadius: LCRadius.r2)
                    .stroke(Color.secondary.opacity(0.3), lineWidth: 1)
            )
        }
        .disabled(isLoading)
    }
}

/// Google "G" multicolor logo
struct GoogleGIcon: View {
    var body: some View {
        Canvas { context, size in
            let w = size.width
            let h = size.height
            let cx = w / 2
            let cy = h / 2
            let r = min(w, h) / 2 * 0.9
            let inner = r * 0.55

            // Blue (right arc: -45° to 45°)
            var blue = Path()
            blue.addArc(center: CGPoint(x: cx, y: cy), radius: r, startAngle: .degrees(-40), endAngle: .degrees(10), clockwise: false)
            blue.addLine(to: CGPoint(x: cx + inner, y: cy + inner * 0.18))
            blue.addArc(center: CGPoint(x: cx, y: cy), radius: inner, startAngle: .degrees(10), endAngle: .degrees(-40), clockwise: true)
            blue.closeSubpath()
            context.fill(blue, with: .color(Color(hex: "#4285f4")))

            // Green (bottom-right: 10° to 120°)
            var green = Path()
            green.addArc(center: CGPoint(x: cx, y: cy), radius: r, startAngle: .degrees(10), endAngle: .degrees(120), clockwise: false)
            green.addArc(center: CGPoint(x: cx, y: cy), radius: inner, startAngle: .degrees(120), endAngle: .degrees(10), clockwise: true)
            green.closeSubpath()
            context.fill(green, with: .color(Color(hex: "#34a853")))

            // Yellow (bottom-left: 120° to 210°)
            var yellow = Path()
            yellow.addArc(center: CGPoint(x: cx, y: cy), radius: r, startAngle: .degrees(120), endAngle: .degrees(210), clockwise: false)
            yellow.addArc(center: CGPoint(x: cx, y: cy), radius: inner, startAngle: .degrees(210), endAngle: .degrees(120), clockwise: true)
            yellow.closeSubpath()
            context.fill(yellow, with: .color(Color(hex: "#fbbc05")))

            // Red (top-left to top: 210° to 320°)
            var red = Path()
            red.addArc(center: CGPoint(x: cx, y: cy), radius: r, startAngle: .degrees(210), endAngle: .degrees(320), clockwise: false)
            red.addArc(center: CGPoint(x: cx, y: cy), radius: inner, startAngle: .degrees(320), endAngle: .degrees(210), clockwise: true)
            red.closeSubpath()
            context.fill(red, with: .color(Color(hex: "#ea4335")))

            // Blue bar (horizontal arm of the G)
            let barH = r * 0.32
            let barRect = CGRect(x: cx - r * 0.05, y: cy - barH / 2, width: r * 1.0, height: barH)
            context.fill(Path(roundedRect: barRect, cornerRadius: barH * 0.15), with: .color(Color(hex: "#4285f4")))
        }
    }
}

struct AuthButton: View {
    let title: String
    var isLoading: Bool = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Group {
                if isLoading {
                    ProgressView()
                        .tint(.white)
                } else {
                    Text(title)
                        .font(LCFont.semibold(15))
                }
            }
            .frame(maxWidth: .infinity)
            .frame(height: 48)
            .background(LCColor.accent)
            .foregroundStyle(.white)
            .clipShape(RoundedRectangle(cornerRadius: LCRadius.r2))
        }
        .disabled(isLoading)
    }
}
