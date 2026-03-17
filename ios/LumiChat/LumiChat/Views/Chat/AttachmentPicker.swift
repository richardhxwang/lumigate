import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

struct AttachmentPicker: ViewModifier {
    @Binding var showPhotoPicker: Bool
    @Binding var showFilePicker: Bool
    let onImage: (UIImage) -> Void
    let onFile: (Data, String, String) -> Void

    @State private var photoItem: PhotosPickerItem?

    func body(content: Content) -> some View {
        content
            .photosPicker(isPresented: $showPhotoPicker, selection: $photoItem, matching: .images)
            .onChange(of: photoItem) { _, item in
                guard let item else { return }
                Task {
                    if let data = try? await item.loadTransferable(type: Data.self),
                       let image = UIImage(data: data) {
                        onImage(image)
                    }
                    photoItem = nil
                }
            }
            .fileImporter(
                isPresented: $showFilePicker,
                allowedContentTypes: [.pdf, .plainText, .json, .commaSeparatedText],
                allowsMultipleSelection: false
            ) { result in
                guard case .success(let urls) = result, let url = urls.first else { return }
                guard url.startAccessingSecurityScopedResource() else { return }
                defer { url.stopAccessingSecurityScopedResource() }
                if let data = try? Data(contentsOf: url) {
                    let mime = mimeType(for: url)
                    onFile(data, url.lastPathComponent, mime)
                }
            }
    }

    private func mimeType(for url: URL) -> String {
        if let type = UTType(filenameExtension: url.pathExtension) {
            return type.preferredMIMEType ?? "application/octet-stream"
        }
        return "application/octet-stream"
    }
}

extension View {
    func attachmentPicker(
        showPhotoPicker: Binding<Bool>,
        showFilePicker: Binding<Bool>,
        onImage: @escaping (UIImage) -> Void,
        onFile: @escaping (Data, String, String) -> Void
    ) -> some View {
        modifier(AttachmentPicker(
            showPhotoPicker: showPhotoPicker,
            showFilePicker: showFilePicker,
            onImage: onImage,
            onFile: onFile
        ))
    }
}
