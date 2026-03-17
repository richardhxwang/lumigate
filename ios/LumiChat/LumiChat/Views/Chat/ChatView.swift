import SwiftUI

struct ChatView: View {
    @Bindable var viewModel: ChatViewModel
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        VStack(spacing: 0) {
            // Chat messages
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 0) {
                        if viewModel.messages.isEmpty && !viewModel.isStreaming {
                            EmptyStateView { suggestion in
                                Task { await viewModel.sendMessage(suggestion) }
                            }
                            .padding(.top, 80)
                        }

                        ForEach(viewModel.messages) { msg in
                            MessageRow(
                                message: msg,
                                onDelete: {
                                    Task { await viewModel.deleteMessage(msg.id) }
                                },
                                onEdit: { newContent in
                                    Task { await viewModel.editAndResend(msg.id, newContent: newContent) }
                                },
                                onResend: msg.role == "user" ? {
                                    Task { await viewModel.resendLastUser() }
                                } : nil
                            )
                        }

                        // Streaming response
                        if viewModel.isStreaming {
                            if viewModel.streamingText.isEmpty {
                                TypingIndicator(isThinking: viewModel.isThinking)
                                    .padding(.horizontal, 24)
                                    .padding(.top, 20)
                            } else {
                                StreamingMessageRow(text: viewModel.streamingText)
                            }
                        }

                        // Search indicator
                        if viewModel.isSearching {
                            SearchIndicator(query: viewModel.searchQuery)
                                .padding(.horizontal, 24)
                                .padding(.top, 8)
                        }

                        Color.clear.frame(height: 1).id("bottom")
                    }
                }
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: viewModel.streamingText) { _, _ in
                    withAnimation(.none) {
                        proxy.scrollTo("bottom", anchor: .bottom)
                    }
                }
                .onChange(of: viewModel.messages.count) { _, _ in
                    withAnimation(.easeOut(duration: 0.3)) {
                        proxy.scrollTo("bottom", anchor: .bottom)
                    }
                }
            }

            // Pending image thumbnails
            if !viewModel.pendingImages.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(viewModel.pendingImages.indices, id: \.self) { i in
                            ZStack(alignment: .topTrailing) {
                                Image(uiImage: viewModel.pendingImages[i])
                                    .resizable()
                                    .scaledToFill()
                                    .frame(width: 56, height: 56)
                                    .clipShape(RoundedRectangle(cornerRadius: LCRadius.r1))

                                Button {
                                    viewModel.removeImage(at: i)
                                } label: {
                                    Image(systemName: "xmark.circle.fill")
                                        .font(.system(size: 16))
                                        .foregroundStyle(.white, .black.opacity(0.6))
                                }
                                .offset(x: 4, y: -4)
                            }
                        }
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 6)
                }
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }

            // Upload indicator
            if viewModel.isUploading {
                HStack(spacing: 6) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Uploading...")
                        .font(LCFont.body(12))
                        .foregroundStyle(.secondary)
                }
                .padding(.vertical, 4)
            }

            // Input bar
            InputBar(
                isStreaming: viewModel.isStreaming,
                webSearchEnabled: $viewModel.webSearchEnabled,
                onSend: { text in
                    Task { await viewModel.sendMessage(text) }
                },
                onStop: {
                    Haptics.warning()
                    viewModel.stopStreaming()
                },
                onImage: { image in
                    viewModel.addImage(image)
                },
                onFile: { data, name, mime in
                    // TODO: file upload handling
                }
            )
        }
        .background(Color(colorScheme == .dark ? LCColor.Dark.bg : LCColor.Light.bg))
        .ignoresSafeArea(.keyboard, edges: .bottom)
    }
}
