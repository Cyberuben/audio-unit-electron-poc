import AVFoundation
import Accelerate
import AudioToolbox
import Foundation

// Serialize stdout writes so events from different queues cannot interleave JSON lines.
let outputQueue = DispatchQueue(label: "events")
func emit(_ data: [String: Any]) {
  outputQueue.async {
    if let json = try? JSONSerialization.data(withJSONObject: data) {
      FileHandle.standardOutput.write(json)
      FileHandle.standardOutput.write(Data([10]))
    }
  }
}

/// Samples channel one for display without making the audio callback wait for FFT/JSON work.
final class SpectrumAnalyser {
  let fftSize = 2048
  let analysisQueue = DispatchQueue(label: "spectrum")
  let analysisGate = DispatchSemaphore(value: 1)
  var lastCaptureTime = 0.0

  func consume(_ buffer: AVAudioPCMBuffer, name: String) {
    let now = ProcessInfo.processInfo.systemUptime
    // Drop visual updates while an analysis is pending; never block audio rendering.
    guard now - lastCaptureTime > 0.075, Int(buffer.frameLength) >= fftSize,
      let channels = buffer.floatChannelData, analysisGate.wait(timeout: .now()) == .success
    else { return }
    lastCaptureTime = now
    // Copy only one channel; FFT/JSON work is moved off the render callback.
    let samples = Array(UnsafeBufferPointer(start: channels[0], count: fftSize))
    let rate = buffer.format.sampleRate
    analysisQueue.async {
      defer { self.analysisGate.signal() }
      var real = samples
      var imaginary = [Float](repeating: 0, count: self.fftSize)
      var realOutput = imaginary
      var imaginaryOutput = imaginary
      // A Hann window reduces spectral leakage at the edges of this short audio slice.
      for i in 0..<self.fftSize {
        real[i] *= 0.5 - 0.5 * cos(2 * .pi * Float(i) / Float(self.fftSize - 1))
      }
      guard let setup = vDSP_DFT_zop_CreateSetup(nil, vDSP_Length(self.fftSize), .FORWARD) else {
        return
      }
      vDSP_DFT_Execute(setup, &real, &imaginary, &realOutput, &imaginaryOutput)
      vDSP_DFT_DestroySetup(setup)
      // Keep positive frequencies, normalize the Hann-windowed magnitude, then convert to dBFS.
      let bins = (0..<self.fftSize / 2).map { i -> Float in
        let magnitude =
          sqrt(realOutput[i] * realOutput[i] + imaginaryOutput[i] * imaginaryOutput[i]) * 4
          / Float(self.fftSize)
        return max(-100, 20 * log10(max(0.00001, magnitude)))
      }
      emit(["type": "spectrum", "channel": name, "bins": bins, "sampleRate": rate])
    }
  }
}

/// Owns the native graph: player → input mixer → optional AU → main mixer → device.
/// Playback state and graph mutations are confined to the main queue.
final class AudioHost {
  let engine = AVAudioEngine()
  let player = AVAudioPlayerNode()
  let input = AVAudioMixerNode()
  var effect: AVAudioUnit?
  var file: AVAudioFile?
  var looping = false
  var playing = false
  var scheduleGeneration = 0
  let inputSpectrum = SpectrumAnalyser()
  let outputSpectrum = SpectrumAnalyser()
  // Parameter address zero is the AU’s own wet/dry mix, not a host-side crossfade.
  var wetDryParameter: AUParameter? { effect?.auAudioUnit.parameterTree?.parameter(withAddress: 0) }

  init() {
    engine.attach(player)
    engine.attach(input)
    let description = AudioComponentDescription(
      componentType: kAudioUnitType_Effect,
      componentSubType: kAudioUnitSubType_AUSoundIsolation,
      componentManufacturer: kAudioUnitManufacturer_Apple,
      componentFlags: 0, componentFlagsMask: 0)
    // Instantiate asynchronously, then attach and publish parameter metadata on the main queue.
    AVAudioUnit.instantiate(with: description) { unit, error in
      DispatchQueue.main.async {
        self.effect = unit
        if let unit { self.engine.attach(unit) }
        let parameters =
          unit?.auAudioUnit.parameterTree?.allParameters.map { parameter -> [String: Any] in
            [
              "id": parameter.address, "name": parameter.displayName, "min": parameter.minValue,
              "max": parameter.maxValue,
              "value": parameter.value,
            ]
          } ?? []
        emit([
          "type": "ready", "available": unit != nil, "parameters": parameters,
          "error": error?.localizedDescription ?? "",
        ])
      }
    }
  }

  func schedulePlayback() {
    guard let file else { return }
    scheduleGeneration += 1
    let token = scheduleGeneration
    player.scheduleFile(file, at: nil, completionCallbackType: .dataPlayedBack) { _ in
      DispatchQueue.main.async {
        // Ignore completion callbacks belonging to a replaced/stopped schedule.
        guard token == self.scheduleGeneration else { return }
        // Rescheduling here repeats the file, but does not promise gapless loop boundaries.
        if self.looping {
          self.schedulePlayback()
          self.player.play()
        } else {
          self.playing = false
          emit(["type": "ended"])
        }
      }
    }
  }

  // Rebuild connections for the new file’s sample rate and channel layout.
  func loadFile(_ path: String) throws {
    let next = try AVAudioFile(forReading: URL(fileURLWithPath: path))
    guard next.length > 0, next.processingFormat.channelCount <= 2 else {
      throw NSError(
        domain: "AudioHost", code: 1,
        userInfo: [NSLocalizedDescriptionKey: "Use a nonempty mono or stereo audio file."])
    }
    scheduleGeneration += 1
    player.stop()
    engine.stop()
    playing = false
    input.removeTap(onBus: 0)
    engine.mainMixerNode.removeTap(onBus: 0)
    engine.disconnectNodeOutput(player)
    engine.disconnectNodeOutput(input)
    if let effect { engine.disconnectNodeOutput(effect) }
    file = next
    let format = next.processingFormat
    engine.connect(player, to: input, format: format)
    if let effect {
      engine.connect(input, to: effect, format: format)
      engine.connect(effect, to: engine.mainMixerNode, format: format)
    } else {
      engine.connect(input, to: engine.mainMixerNode, format: format)
    }
    // The two meters observe the actual signals before and after the effect.
    input.installTap(onBus: 0, bufferSize: 4096, format: nil) { buffer, _ in
      self.inputSpectrum.consume(buffer, name: "input")
    }
    engine.mainMixerNode.installTap(onBus: 0, bufferSize: 4096, format: nil) { buffer, _ in
      self.outputSpectrum.consume(buffer, name: "output")
    }
    engine.prepare()
    try engine.start()
    schedulePlayback()
    emit([
      "type": "loaded", "name": URL(fileURLWithPath: path).lastPathComponent,
      "duration": Double(next.length) / format.sampleRate, "sampleRate": format.sampleRate,
      "channels": format.channelCount,
    ])
  }

  func handleCommand(_ data: [String: Any]) {
    do {
      switch data["command"] as? String {
      case "load": if let path = data["path"] as? String { try loadFile(path) }
      case "play":
        guard file != nil else { return }
        if !engine.isRunning { try engine.start() }
        if !playing && !player.isPlaying { player.play() }
        playing = true
        emit(["type": "playing"])
      case "pause":
        player.pause()
        playing = false
        emit(["type": "paused"])
      case "restart":
        player.stop()
        schedulePlayback()
        if playing { player.play() }
      case "loop": looping = data["value"] as? Bool ?? false
      case "bypass": effect?.auAudioUnit.shouldBypassEffect = data["value"] as? Bool ?? false
      case "mix":
        if let value = data["value"] as? Float, value.isFinite, let wetDryParameter {
          wetDryParameter.value = min(
            wetDryParameter.maxValue, max(wetDryParameter.minValue, value))
        }
      case "quit":
        engine.stop()
        exit(0)
      default: break
      }
    } catch { emit(["type": "error", "message": error.localizedDescription, "playing": playing]) }
  }
}

let host = AudioHost()
// Reading stdin blocks, so keep it off the main run loop used by AVAudioEngine commands.
DispatchQueue.global().async {
  while let line = readLine() {
    guard let data = line.data(using: .utf8),
      let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    else { continue }
    DispatchQueue.main.async { host.handleCommand(message) }
  }
  exit(0)
}
RunLoop.main.run()
