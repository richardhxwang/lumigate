import SwiftUI

struct SplashView: View {
    @State private var ballOffset: CGFloat = -300
    @State private var ballScale: CGSize = CGSize(width: 1, height: 1)
    @State private var titleOpacity: Double = 0
    @State private var titleOffset: CGFloat = 8

    var body: some View {
        ZStack {
            Color(LCColor.Dark.bg)
                .ignoresSafeArea()

            VStack(spacing: 18) {
                // Bouncing ball
                LumiChatLogo(size: 64)
                    .offset(y: ballOffset)
                    .scaleEffect(ballScale)

                // Title
                Text("LumiChat")
                    .font(LCFont.bold(26))
                    .foregroundStyle(Color(hex: "#ececec"))
                    .opacity(titleOpacity)
                    .offset(y: titleOffset)
            }
        }
        .task {
            await animateSplash()
        }
    }

    private func animateSplash() async {
        // Ball drop with bounce
        withAnimation(.spring(duration: 0.8, bounce: 0.4)) {
            ballOffset = 0
        }

        try? await Task.sleep(for: .milliseconds(800))

        // Title fade in
        withAnimation(.easeOut(duration: 0.5)) {
            titleOpacity = 1
            titleOffset = 0
        }
    }
}

// MARK: - Shared Logo

struct LumiChatLogo: View {
    let size: CGFloat

    var body: some View {
        ZStack {
            Circle()
                .fill(LCColor.accent)
                .frame(width: size, height: size)

            // Arc path
            Path { path in
                let center = CGPoint(x: size / 2, y: size / 2)
                let radius = size * 0.2
                path.addArc(
                    center: center,
                    radius: radius,
                    startAngle: .degrees(-180),
                    endAngle: .degrees(90),
                    clockwise: false
                )
            }
            .stroke(.white, style: StrokeStyle(lineWidth: size * 0.06, lineCap: .round))

            // Center dot
            Circle()
                .fill(.white)
                .frame(width: size * 0.15, height: size * 0.15)
        }
        .frame(width: size, height: size)
    }
}
