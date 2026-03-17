import SwiftUI

struct InputBar: View {
    let isStreaming: Bool
    @Binding var webSearchEnabled: Bool
    let onSend: (String) -> Void
    let onStop: () -> Void
    var onImage: ((UIImage) -> Void)?
    var onFile: ((Data, String, String) -> Void)?

    @State private var text = ""
    @State private var showPhotoPicker = false
    @State private var showFilePicker = false
    @State private var showAttachMenu = false
    @FocusState private var isFocused: Bool
    @Environment(\.colorScheme) private var colorScheme
    @State private var voiceService = VoiceService()

    var body: some View {
        VStack(spacing: 0) {
            // Voice transcript preview
            if voiceService.isListening {
                HStack(spacing: 8) {
                    // Pulsing dot
                    Circle()
                        .fill(LCColor.red)
                        .frame(width: 8, height: 8)
                        .opacity(voiceService.isListening ? 1 : 0.3)

                    Text(voiceService.transcript.isEmpty ? "Listening..." : voiceService.transcript)
                        .font(LCFont.body(13))
                        .foregroundStyle(.secondary)
                        .lineLimit(2)

                    Spacer()

                    Button {
                        voiceService.stopListening()
                        if !voiceService.transcript.isEmpty {
                            text = voiceService.transcript
                        }
                    } label: {
                        Text("Done")
                            .font(LCFont.medium(13))
                            .foregroundStyle(LCColor.accent)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                .background(colors.inp.opacity(0.8))
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            // Input box
            HStack(alignment: .bottom, spacing: 0) {
                VStack(spacing: 0) {
                    // Text editor
                    TextField("Message", text: $text, axis: .vertical)
                        .lineLimit(1...8)
                        .padding(.horizontal, 16)
                        .padding(.top, 14)
                        .padding(.bottom, 4)
                        .focused($isFocused)
                        .onSubmit { send() }
                        .font(LCFont.body(15))

                    // Toolbar
                    HStack(spacing: 4) {
                        // Web search toggle
                        Button {
                            webSearchEnabled.toggle()
                            Haptics.select()
                        } label: {
                            Image(systemName: "globe")
                                .font(.system(size: 16))
                                .frame(width: 32, height: 32)
                                .foregroundStyle(webSearchEnabled ? LCColor.accent : colors.t3)
                                .background(webSearchEnabled ? LCColor.accent.opacity(0.1) : .clear)
                                .clipShape(RoundedRectangle(cornerRadius: LCRadius.r1))
                        }

                        // Attach menu
                        Menu {
                            Button {
                                showPhotoPicker = true
                            } label: {
                                Label("Photo Library", systemImage: "photo")
                            }
                            Button {
                                showFilePicker = true
                            } label: {
                                Label("File", systemImage: "doc")
                            }
                        } label: {
                            Image(systemName: "paperclip")
                                .font(.system(size: 16))
                                .frame(width: 32, height: 32)
                                .foregroundStyle(colors.t3)
                        }

                        // Voice input
                        Button {
                            Task {
                                if !voiceService.isListening {
                                    let granted = await voiceService.requestPermission()
                                    if granted {
                                        withAnimation(.spring(duration: 0.3)) {
                                            voiceService.startListening()
                                        }
                                    }
                                } else {
                                    withAnimation(.spring(duration: 0.3)) {
                                        voiceService.stopListening()
                                        if !voiceService.transcript.isEmpty {
                                            text = voiceService.transcript
                                        }
                                    }
                                }
                            }
                        } label: {
                            Image(systemName: voiceService.isListening ? "mic.fill" : "mic")
                                .font(.system(size: 16))
                                .frame(width: 32, height: 32)
                                .foregroundStyle(voiceService.isListening ? LCColor.red : colors.t3)
                        }

                        Spacer()

                        // Send / Stop button
                        if isStreaming {
                            Button(action: onStop) {
                                Image(systemName: "pause.fill")
                                    .font(.system(size: 12))
                                    .foregroundStyle(.white)
                                    .frame(width: 34, height: 34)
                                    .background(.ultraThinMaterial)
                                    .clipShape(Circle())
                                    .overlay(Circle().stroke(.white.opacity(0.22), lineWidth: 1.5))
                            }
                        } else {
                            Button(action: send) {
                                Image(systemName: "arrow.up")
                                    .font(.system(size: 15, weight: .semibold))
                                    .foregroundStyle(.white)
                                    .frame(width: 34, height: 34)
                                    .background(.ultraThinMaterial)
                                    .clipShape(Circle())
                                    .overlay(Circle().stroke(.white.opacity(canSend ? 0.22 : 0.08), lineWidth: 1.5))
                            }
                            .disabled(!canSend)
                            .opacity(canSend ? 1 : 0.45)
                        }
                    }
                    .padding(.horizontal, 10)
                    .padding(.bottom, 4)
                }
                .background(colors.inp)
                .clipShape(RoundedRectangle(cornerRadius: LCRadius.r3))
                .overlay(
                    RoundedRectangle(cornerRadius: LCRadius.r3)
                        .stroke(isFocused ? colors.inpBorder.opacity(0.8) : colors.inpBorder.opacity(0.4), lineWidth: 1)
                )
            }
            .padding(.horizontal, 16)
            .padding(.top, 6)
            .padding(.bottom, 2)
        }
        .attachmentPicker(
            showPhotoPicker: $showPhotoPicker,
            showFilePicker: $showFilePicker,
            onImage: { image in onImage?(image) },
            onFile: { data, name, mime in onFile?(data, name, mime) }
        )
    }

    private var canSend: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isStreaming
    }

    private var colors: LCColors { LCColors(colorScheme: colorScheme) }

    private func send() {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        Haptics.impact()
        text = ""
        onSend(t)
    }
}
