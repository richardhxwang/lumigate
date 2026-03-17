import Foundation
import UIKit

struct UploadedFile: Codable, Identifiable, Sendable {
    let id: String
    let filename: String
    let content_type: String
    let size: Int?
    let url: String?
}

actor FileService {
    static let shared = FileService()
    private let api = APIClient.shared

    func uploadImage(_ image: UIImage, quality: CGFloat = 0.8) async throws -> UploadedFile {
        guard let data = image.jpegData(compressionQuality: quality) else {
            throw FileError.compressionFailed
        }
        let filename = "image_\(Int(Date().timeIntervalSince1970)).jpg"
        return try await api.upload("/lc/files", fileData: data, fileName: filename, mimeType: "image/jpeg")
    }

    func uploadFile(data: Data, filename: String, mimeType: String) async throws -> UploadedFile {
        guard data.count <= 20 * 1024 * 1024 else {
            throw FileError.tooLarge
        }
        return try await api.upload("/lc/files", fileData: data, fileName: filename, mimeType: mimeType)
    }

    /// Resize image if needed (max 2048px on longest side)
    func prepareImage(_ image: UIImage) -> UIImage {
        let maxDim: CGFloat = 2048
        let size = image.size
        guard size.width > maxDim || size.height > maxDim else { return image }
        let scale = maxDim / max(size.width, size.height)
        let newSize = CGSize(width: size.width * scale, height: size.height * scale)
        let renderer = UIGraphicsImageRenderer(size: newSize)
        return renderer.image { _ in image.draw(in: CGRect(origin: .zero, size: newSize)) }
    }
}

enum FileError: Error, LocalizedError {
    case compressionFailed
    case tooLarge
    case unsupportedType

    var errorDescription: String? {
        switch self {
        case .compressionFailed: "Failed to compress image"
        case .tooLarge: "File exceeds 20MB limit"
        case .unsupportedType: "Unsupported file type"
        }
    }
}
