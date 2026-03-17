import Foundation
import Speech
import AVFoundation

@MainActor
@Observable
class VoiceService: NSObject {
    var isListening = false
    var transcript = ""
    var error: String?

    private var recognizer: SFSpeechRecognizer?
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var audioEngine = AVAudioEngine()

    override init() {
        super.init()
        recognizer = SFSpeechRecognizer(locale: Locale.current)
    }

    func requestPermission() async -> Bool {
        let speechStatus = await withCheckedContinuation { cont in
            SFSpeechRecognizer.requestAuthorization { status in
                cont.resume(returning: status)
            }
        }
        guard speechStatus == .authorized else {
            error = "Speech recognition not authorized"
            return false
        }

        let audioStatus = await AVAudioApplication.requestRecordPermission()
        guard audioStatus else {
            error = "Microphone access not authorized"
            return false
        }
        return true
    }

    func startListening() {
        guard !isListening else { return }
        guard let recognizer, recognizer.isAvailable else {
            error = "Speech recognition not available"
            return
        }

        transcript = ""
        error = nil

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.addsPunctuation = true
        self.recognitionRequest = request

        let inputNode = audioEngine.inputNode
        let recordingFormat = inputNode.outputFormat(forBus: 0)

        inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { buffer, _ in
            request.append(buffer)
        }

        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.record, mode: .measurement, options: .duckOthers)
            try session.setActive(true, options: .notifyOthersOnDeactivation)
            try audioEngine.start()
        } catch {
            self.error = error.localizedDescription
            return
        }

        recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            Task { @MainActor in
                guard let self else { return }
                if let result {
                    self.transcript = result.bestTranscription.formattedString
                }
                if let error {
                    // Ignore cancellation errors
                    let nsError = error as NSError
                    if nsError.domain != "kAFAssistantErrorDomain" || nsError.code != 216 {
                        self.error = error.localizedDescription
                    }
                    self.stopListening()
                }
                if result?.isFinal == true {
                    self.stopListening()
                }
            }
        }

        isListening = true
        Haptics.impact()
    }

    func stopListening() {
        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)
        recognitionRequest?.endAudio()
        recognitionTask?.cancel()
        recognitionRequest = nil
        recognitionTask = nil
        isListening = false

        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    func toggle() {
        if isListening {
            stopListening()
        } else {
            startListening()
        }
    }
}
