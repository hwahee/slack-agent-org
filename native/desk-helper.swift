// desk-helper — the agent's hands on macOS.
//
// Posts real mouse and keyboard events through CoreGraphics (CGEvent), the
// same events a trackpad and keyboard produce. Coordinates are global screen
// points (origin: top-left of the main display). Called by src/desk/macos.ts;
// the key names below must match src/desk/keys.ts.
//
//   desk-helper display                       → {"width":1440,"height":900}
//   desk-helper check                         → {"accessibility":true,"screenRecording":true}
//   desk-helper request                       same, but asks macOS to show its permission prompts
//                                             (this also adds the app to the lists in System Settings)
//   desk-helper move   X Y
//   desk-helper click  X Y [left|right] [1|2]
//   desk-helper scroll X Y LINES              (positive = down)
//   desk-helper key    COMBO                  e.g. cmd+k, shift+return
//   desk-helper type                          (text from stdin)
//
// Eyes — work on frames already captured by `screencapture` (src/desk/macos.ts).
// WIDTH×HEIGHT is the pixel space the model sees; every box is reported in it.
//
//   desk-helper diff BEFORE AFTER WIDTH HEIGHT CELL
//       → {"ratio":0.03,"areas":[{"x":0,"y":0,"width":24,"height":12,"cells":2}]}
//         changed areas between two frames, compared in CELL×CELL blocks
//   desk-helper ocr IMAGE WIDTH HEIGHT [X Y W H]
//       → [{"text":"안녕하세요","x":10,"y":20,"width":80,"height":14}]
//         text lines on the frame (only inside the box, when given)
//
// Build: bun run desk:build   (swiftc -O native/desk-helper.swift -o .bin/desk-helper)

import ApplicationServices
import CoreGraphics
import Foundation
import ImageIO
import Vision

func fail(_ message: String, code: Int32 = 1) -> Never {
  FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
  exit(code)
}

func number(_ text: String?) -> Double {
  guard let text = text, let value = Double(text) else {
    fail("not a number: \(text ?? "(missing)")", code: 64)
  }
  return value
}

func pause(milliseconds: UInt32) {
  usleep(milliseconds * 1000)
}

let source = CGEventSource(stateID: .hidSystemState)

func post(_ event: CGEvent?) {
  guard let event = event else {
    fail("could not create the event — is Accessibility granted to this process?")
  }
  event.post(tap: .cghidEventTap)
}

// MARK: - Mouse

func move(to point: CGPoint) {
  post(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left))
}

func click(at point: CGPoint, right: Bool, count: Int) {
  move(to: point)
  pause(milliseconds: 60)
  let downType: CGEventType = right ? .rightMouseDown : .leftMouseDown
  let upType: CGEventType = right ? .rightMouseUp : .leftMouseUp
  let button: CGMouseButton = right ? .right : .left
  for clickState in 1...count {
    let down = CGEvent(mouseEventSource: source, mouseType: downType, mouseCursorPosition: point, mouseButton: button)
    down?.setIntegerValueField(.mouseEventClickState, value: Int64(clickState))
    post(down)
    pause(milliseconds: 40)
    let up = CGEvent(mouseEventSource: source, mouseType: upType, mouseCursorPosition: point, mouseButton: button)
    up?.setIntegerValueField(.mouseEventClickState, value: Int64(clickState))
    post(up)
    pause(milliseconds: 70)
  }
}

func scroll(at point: CGPoint, lines: Int32) {
  move(to: point)
  pause(milliseconds: 40)
  // wheel1 > 0 scrolls up, so "down" is negative.
  post(CGEvent(scrollWheelEvent2Source: source, units: .line, wheelCount: 1, wheel1: -lines, wheel2: 0, wheel3: 0))
}

// MARK: - Keyboard

// ANSI virtual key codes (Carbon kVK_*). Shortcuts use these, so they work
// whatever the active input source is.
let keyCodes: [String: CGKeyCode] = [
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
  "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
  "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26,
  "-": 27, "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35,
  "return": 36, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43,
  "/": 44, "n": 45, "m": 46, ".": 47, "tab": 48, "space": 49, "`": 50,
  "delete": 51, "escape": 53,
  "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100,
  "f9": 101, "f10": 109, "f11": 103, "f12": 111,
  "home": 115, "pageup": 116, "forwarddelete": 117, "end": 119, "pagedown": 121,
  "left": 123, "right": 124, "down": 125, "up": 126,
]

// Physical modifier keys, pressed and released around the key like a real
// keyboard does. Releasing them explicitly matters: an app that tracks
// modifiers through flagsChanged would otherwise think cmd is still held, and
// swallow the next keystrokes as shortcuts.
let modifierKeys: [String: (code: CGKeyCode, flag: CGEventFlags)] = [
  "cmd": (55, .maskCommand),
  "shift": (56, .maskShift),
  "alt": (58, .maskAlternate),
  "ctrl": (59, .maskControl),
  "fn": (63, .maskSecondaryFn),
]

func keyEvent(_ code: CGKeyCode, down: Bool, flags: CGEventFlags) {
  let event = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down)
  event?.flags = flags
  post(event)
}

func press(combo: String) {
  var parts = combo.split(separator: "+").map(String.init)
  guard let keyName = parts.popLast(), let code = keyCodes[keyName] else {
    fail("unknown key in \(combo)", code: 64)
  }
  var held: [(code: CGKeyCode, flag: CGEventFlags)] = []
  var flags: CGEventFlags = []
  for name in parts {
    guard let modifier = modifierKeys[name] else { fail("unknown modifier \(name)", code: 64) }
    flags.insert(modifier.flag)
    keyEvent(modifier.code, down: true, flags: flags)
    held.append(modifier)
    pause(milliseconds: 15)
  }
  keyEvent(code, down: true, flags: flags)
  pause(milliseconds: 30)
  keyEvent(code, down: false, flags: flags)
  for modifier in held.reversed() {
    pause(milliseconds: 15)
    flags.remove(modifier.flag)
    keyEvent(modifier.code, down: false, flags: flags)
  }
  pause(milliseconds: 50)
}

// Types each character as a Unicode keystroke — independent of the keyboard
// layout, so Korean and emoji arrive as written. (Keep the input source on a
// plain layout such as ABC: an active IME may re-interpret keystrokes.)
func type(text: String) {
  // Give the field that was just clicked a moment to take focus; the first
  // character was getting lost right after a click.
  pause(milliseconds: 150)
  for character in text {
    var units = Array(String(character).utf16)
    for down in [true, false] {
      let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
      event?.flags = [] // never inherit a modifier: "a" typed while cmd is held is cmd+a
      event?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
      post(event)
      pause(milliseconds: down ? 8 : 12)
    }
  }
}

// MARK: - Eyes

func printJSON(_ value: Any) {
  guard let data = try? JSONSerialization.data(withJSONObject: value, options: []),
    let text = String(data: data, encoding: .utf8)
  else { fail("cannot encode the result as JSON") }
  print(text)
}

func loadImage(_ path: String) -> CGImage {
  guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
    let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
  else { fail("cannot read image: \(path)") }
  return image
}

// RGBA bytes of `image` drawn at width×height; row 0 is the top of the image.
func rgba(_ image: CGImage, width: Int, height: Int) -> [UInt8] {
  var pixels = [UInt8](repeating: 0, count: width * height * 4)
  let drawn = pixels.withUnsafeMutableBytes { buffer -> Bool in
    guard
      let context = CGContext(
        data: buffer.baseAddress, width: width, height: height, bitsPerComponent: 8,
        bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
    else { return false }
    context.interpolationQuality = .medium
    context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
    return true
  }
  if !drawn { fail("cannot draw image at \(width)x\(height)") }
  return pixels
}

// Changed areas between two frames. Both are drawn at width×height and
// compared in cell×cell blocks; a block changed when at least two of its pixels
// did. Touching blocks (8-way) form one area. `ratio` is the changed share of
// all blocks.
func diff(before: CGImage, after: CGImage, width: Int, height: Int, cell: Int) -> [String: Any] {
  let a = rgba(before, width: width, height: height)
  let b = rgba(after, width: width, height: height)
  let columns = (width + cell - 1) / cell
  let rows = (height + cell - 1) / cell
  var changed = [Bool](repeating: false, count: columns * rows)
  var changedCount = 0
  for row in 0..<rows {
    for column in 0..<columns {
      var differing = 0
      scan: for y in (row * cell)..<min((row + 1) * cell, height) {
        for x in (column * cell)..<min((column + 1) * cell, width) {
          let i = (y * width + x) * 4
          let delta =
            abs(Int(a[i]) - Int(b[i])) + abs(Int(a[i + 1]) - Int(b[i + 1]))
            + abs(Int(a[i + 2]) - Int(b[i + 2]))
          if delta > 48 {
            differing += 1
            if differing >= 2 { break scan }
          }
        }
      }
      if differing >= 2 {
        changed[row * columns + column] = true
        changedCount += 1
      }
    }
  }

  var seen = [Bool](repeating: false, count: columns * rows)
  var areas: [[String: Int]] = []
  for start in 0..<(columns * rows) where changed[start] && !seen[start] {
    var stack = [start]
    seen[start] = true
    var minColumn = columns
    var minRow = rows
    var maxColumn = 0
    var maxRow = 0
    var cells = 0
    while let index = stack.popLast() {
      let row = index / columns
      let column = index % columns
      cells += 1
      minColumn = min(minColumn, column)
      maxColumn = max(maxColumn, column)
      minRow = min(minRow, row)
      maxRow = max(maxRow, row)
      for dy in -1...1 {
        for dx in -1...1 {
          let r = row + dy
          let c = column + dx
          if r < 0 || r >= rows || c < 0 || c >= columns { continue }
          let next = r * columns + c
          if changed[next] && !seen[next] {
            seen[next] = true
            stack.append(next)
          }
        }
      }
    }
    let x = minColumn * cell
    let y = minRow * cell
    areas.append([
      "x": x,
      "y": y,
      "width": min((maxColumn + 1) * cell, width) - x,
      "height": min((maxRow + 1) * cell, height) - y,
      "cells": cells,
    ])
  }
  let total = max(1, columns * rows)
  return ["ratio": Double(changedCount) / Double(total), "areas": areas]
}

// Text lines on a frame, in the width×height pixel space (origin top-left).
// Reads Korean and English, the way the screen shows them.
func recognizeText(in image: CGImage, width: Double, height: Double, region: CGRect?) -> [[String: Any]] {
  let request = VNRecognizeTextRequest()
  request.recognitionLevel = .accurate
  request.recognitionLanguages = ["ko-KR", "en-US"]
  request.usesLanguageCorrection = true

  // Vision's rectangles are normalized, with the origin at the bottom-left.
  let whole = CGRect(x: 0, y: 0, width: 1, height: 1)
  var interest = whole
  if let region = region {
    interest = CGRect(
      x: region.minX / width, y: 1 - region.maxY / height,
      width: region.width / width, height: region.height / height
    ).intersection(whole)
    if interest.isNull || interest.isEmpty { return [] }
    request.regionOfInterest = interest
  }

  let handler = VNImageRequestHandler(cgImage: image, options: [:])
  do {
    try handler.perform([request])
  } catch {
    fail("text recognition failed: \(error)")
  }

  var lines: [[String: Any]] = []
  for observation in request.results ?? [] {
    guard let candidate = observation.topCandidates(1).first else { continue }
    // Boxes come back relative to the region of interest.
    let box = observation.boundingBox
    let left = (interest.minX + box.minX * interest.width) * width
    let top = (1 - (interest.minY + box.maxY * interest.height)) * height
    lines.append([
      "text": candidate.string,
      "x": Int(left.rounded()),
      "y": Int(top.rounded()),
      "width": Int((box.width * interest.width * width).rounded()),
      "height": Int((box.height * interest.height * height).rounded()),
    ])
  }
  return lines
}

// MARK: - Main

let arguments = Array(CommandLine.arguments.dropFirst())
guard let command = arguments.first else {
  fail("usage: desk-helper display|check|move|click|scroll|key|type|diff|ocr …", code: 64)
}
let rest = Array(arguments.dropFirst())

switch command {
case "display":
  let bounds = CGDisplayBounds(CGMainDisplayID())
  print("{\"width\":\(Int(bounds.width)),\"height\":\(Int(bounds.height))}")

case "check":
  let accessibility = AXIsProcessTrusted()
  let screenRecording = CGPreflightScreenCaptureAccess()
  print("{\"accessibility\":\(accessibility),\"screenRecording\":\(screenRecording)}")

case "request":
  let prompt = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
  let accessibility = AXIsProcessTrustedWithOptions(prompt)
  let screenRecording = CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess()
  print("{\"accessibility\":\(accessibility),\"screenRecording\":\(screenRecording)}")

case "move":
  move(to: CGPoint(x: number(rest.first), y: number(rest.dropFirst().first)))

case "click":
  let point = CGPoint(x: number(rest.first), y: number(rest.dropFirst().first))
  let button = rest.count > 2 ? rest[2] : "left"
  let count = rest.count > 3 ? Int(number(rest[3])) : 1
  guard button == "left" || button == "right" else { fail("button must be left or right", code: 64) }
  guard count == 1 || count == 2 else { fail("count must be 1 or 2", code: 64) }
  click(at: point, right: button == "right", count: count)

case "scroll":
  let point = CGPoint(x: number(rest.first), y: number(rest.dropFirst().first))
  scroll(at: point, lines: Int32(number(rest.count > 2 ? rest[2] : nil)))

case "key":
  guard let combo = rest.first else { fail("usage: desk-helper key COMBO", code: 64) }
  press(combo: combo)

case "type":
  let input = FileHandle.standardInput.readDataToEndOfFile()
  type(text: String(decoding: input, as: UTF8.self))

case "diff":
  guard rest.count == 5 else { fail("usage: desk-helper diff BEFORE AFTER WIDTH HEIGHT CELL", code: 64) }
  let width = Int(number(rest[2]))
  let height = Int(number(rest[3]))
  let cell = Int(number(rest[4]))
  guard width > 0, height > 0, cell > 0 else { fail("WIDTH, HEIGHT and CELL must be positive", code: 64) }
  printJSON(diff(before: loadImage(rest[0]), after: loadImage(rest[1]), width: width, height: height, cell: cell))

case "ocr":
  guard rest.count == 3 || rest.count == 7 else {
    fail("usage: desk-helper ocr IMAGE WIDTH HEIGHT [X Y W H]", code: 64)
  }
  let width = number(rest[1])
  let height = number(rest[2])
  guard width > 0, height > 0 else { fail("WIDTH and HEIGHT must be positive", code: 64) }
  let region: CGRect? =
    rest.count == 7
    ? CGRect(x: number(rest[3]), y: number(rest[4]), width: number(rest[5]), height: number(rest[6]))
    : nil
  printJSON(recognizeText(in: loadImage(rest[0]), width: width, height: height, region: region))

default:
  fail("unknown command: \(command)", code: 64)
}
