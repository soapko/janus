# Task 016: Voice-to-Text Input

## Overview

Add a microphone button inside the chat input field that records speech and transcribes it locally using Moonshine JS. All processing happens on-device — no cloud APIs, no accounts, no cost.

## Current State

- `ChatInput.tsx` has a textarea with attach (+) button on the left and Send/Stop button on the right
- No voice input capability
- `@huggingface/transformers` is already a dependency (unused for this feature)

## Target State

### Microphone Button

A mic icon button inside the input row, between the textarea and the Send button:

```
┌─────────────────────────────────────┐
│ [+]  [Type a message...     ] 🎙 [Send] │
└─────────────────────────────────────┘
```

### Recording State

When recording, the mic button pulses red and the textarea shows live transcription:

```
┌─────────────────────────────────────┐
│ [+]  [What about the login flow█ ] 🔴 [Send] │
└─────────────────────────────────────┘
```

- Mic button turns red with pulse animation while listening
- Textarea shows live partial transcription (streaming mode)
- VAD auto-detects when user stops talking → commits final text
- Click mic again to stop early
- Transcribed text appends to any existing text in the textarea (doesn't replace)

### Behavior

1. Click mic button → request microphone permission (first time only)
2. Start recording → mic button turns red, pulses
3. As user speaks → partial transcript appears in textarea (real-time updates)
4. User pauses (VAD detects silence) → final transcript committed, recording continues
5. Click mic again → stop recording, mic returns to normal state
6. User can then edit the transcribed text before sending

## Technology

**Package:** `@moonshine-ai/moonshine-js`
- MIT license, free, fully local
- ONNX + WebAssembly — runs in renderer process
- Built-in Voice Activity Detection (VAD)
- Streaming mode with `onTranscriptionUpdated` + `onTranscriptionCommitted` callbacks
- Model: `model/tiny` (~50MB, downloaded on first use)

## Implementation Plan

### Phase 1: Install dependency

```bash
npm install @moonshine-ai/moonshine-js
```

### Phase 2: Add mic button to ChatInput

**File:** `ChatInput.tsx`

1. Add state: `isRecording`, `transcriber` ref
2. Add mic button between textarea and Send button
3. On click:
   - If not recording: create `MicrophoneTranscriber`, call `start()`
   - If recording: call `stop()`, reset state
4. `onTranscriptionUpdated(text)` → append partial text to textarea value
5. `onTranscriptionCommitted(text)` → finalize text in textarea
6. Track `pendingTranscript` (uncommitted partial) separately from committed text

### Phase 3: CSS for mic button and recording states

**File:** `chat.css`

- `.chat-input-mic-btn` — same size/style as attach button
- `.chat-input-mic-btn--recording` — red background with pulse animation
- Reuse existing `interject-pulse` keyframes or similar

### Phase 4: Model loading state

- First time mic is clicked, model downloads (~50MB)
- Show a brief loading indicator (e.g., mic button shows spinner/dots)
- After model loads, recording starts automatically
- Model stays in memory for subsequent uses

## Edge Cases

- Microphone permission denied → show error, reset button state
- Model download fails → show error, allow retry
- User sends message while recording → stop recording, send text
- User switches tabs while recording → stop recording
- Recording during streaming response → should work fine (independent)
- Empty transcription (silence) → no text added

## Testing

- Click mic → permission prompt appears (first time)
- Speak → text appears in textarea in real-time
- Pause speaking → text commits, cursor at end
- Click mic again → recording stops
- Send → transcribed text sends as normal message
- Click mic → speak → click Send → recording stops, text sends
