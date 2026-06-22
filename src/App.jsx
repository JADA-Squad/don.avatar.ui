import React, { useEffect, useState, useRef } from 'react';
import * as SpeechSDK from 'microsoft-cognitiveservices-speech-sdk';
import ReactMarkdown from 'react-markdown';
import SpatiusAvatar from './SpatiusAvatar.jsx';
import VoiceWave from './VoiceWave.jsx';
import './App.css';

const MicIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/>
    <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
    <line x1="12" y1="19" x2="12" y2="23"/>
    <line x1="8" y1="23" x2="16" y2="23"/>
  </svg>
);

const StopIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor">
    <rect x="4" y="4" width="16" height="16" rx="2"/>
  </svg>
);

const ResetIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
    <path d="M3 3v5h5"/>
  </svg>
);

const SendIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
    <line x1="22" y1="2" x2="11" y2="13"/>
    <polygon points="22 2 15 22 11 13 2 9 22 2"/>
  </svg>
);

// Call Azure TTS and return the spoken audio as raw 16-bit PCM @ 24kHz mono.
// The Spatius avatar lip-syncs to this PCM (it does the visemes server-side), and
// the Voice view plays the same PCM through Web Audio so the waveform reacts.
async function synthesizeSpeech(text) {
  // Fetch a short-lived token from our server - the actual key stays server-side
  const tokenRes = await fetch('/api/speech-token');
  if (!tokenRes.ok) throw new Error('Could not obtain speech token from server.');
  const { token, region } = await tokenRes.json();

  return new Promise((resolve, reject) => {
    const speechConfig = SpeechSDK.SpeechConfig.fromAuthorizationToken(token, region);
    speechConfig.speechSynthesisVoiceName = 'en-US-JennyNeural';
    // Headerless raw PCM16 @ 24kHz: matches the avatar's expected audio format
    // and is trivial to feed straight into a Web Audio buffer.
    speechConfig.speechSynthesisOutputFormat = SpeechSDK.SpeechSynthesisOutputFormat.Raw24Khz16BitMonoPcm;
    // null audioConfig means the SDK returns full audio as ArrayBuffer in result.audioData
    const synthesizer = new SpeechSDK.SpeechSynthesizer(speechConfig, null);
    synthesizer.speakTextAsync(
      text,
      (result) => {
        synthesizer.close();
        if (result.reason === SpeechSDK.ResultReason.SynthesizingAudioCompleted) {
          resolve({ audioData: result.audioData, sampleRate: 24000 });
        } else {
          reject(new Error(result.errorDetails || 'TTS synthesis failed'));
        }
      },
      (err) => { synthesizer.close(); reject(new Error(err)); }
    );
  });
}

// Taps the microphone into an analyser while active, so the waveform reacts to
// the user's voice while listening. Reuses the shared AudioContext and never
// connects to the speakers (no echo). Failures degrade silently to idle motion.
function useMicAudio(active, audioCtxRef) {
  const analyserRef = useRef(null);
  useEffect(() => {
    if (!active) return;
    let cancelled = false, stream = null, src = null;
    navigator.mediaDevices?.getUserMedia({ audio: true })
      .then((s) => {
        if (cancelled) { s.getTracks().forEach((t) => t.stop()); return; }
        stream = s;
        const ctx = audioCtxRef.current || (audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)());
        ctx.resume?.();
        const an = ctx.createAnalyser();
        an.fftSize = 1024;
        an.smoothingTimeConstant = 0.82;
        src = ctx.createMediaStreamSource(stream);
        src.connect(an); // analyser only, not to destination
        analyserRef.current = an;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      try { src?.disconnect(); } catch {}
      analyserRef.current = null;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [active]);
  return analyserRef;
}

export default function App() {
  const defaultMessage = { sender: 'bot', text: 'Hello. How can I assist you with your telecoms Instagram campaign analysis today?' };
  const [messages, setMessages] = useState([defaultMessage]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isAvatarSpeaking, setIsAvatarSpeaking] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [micError, setMicError] = useState('');
  const [viewMode, setViewMode] = useState('voice'); // 'avatar' | 'voice'

  const avatarRef = useRef(null);
  const audioCtxRef = useRef(null);
  const ttsAnalyserRef = useRef(null);
  const ttsSourceRef = useRef(null);
  const recognitionRef = useRef(null);
  const transcriptRef = useRef('');
  const messagesEndRef = useRef(null);
  const sendMsgRef = useRef(null);
  const viewModeRef = useRef(viewMode);
  viewModeRef.current = viewMode;

  // Mic analyser drives the waveform while listening.
  const micAnalyserRef = useMicAudio(isListening, audioCtxRef);

  // Auto-scroll chat to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // === AUDIO PLAYBACK (Voice view) ===
  function stopPcm() {
    if (ttsSourceRef.current) {
      try { ttsSourceRef.current.stop(); } catch {}
      ttsSourceRef.current = null;
    }
    setIsAvatarSpeaking(false);
  }

  // Play raw PCM16 through Web Audio with an analyser the waveform reads.
  function playPcm(arrayBuffer, sampleRate) {
    const ctx = audioCtxRef.current || (audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)());
    ctx.resume?.();
    if (!ttsAnalyserRef.current) {
      const an = ctx.createAnalyser();
      an.fftSize = 1024;
      an.smoothingTimeConstant = 0.82;
      an.connect(ctx.destination);
      ttsAnalyserRef.current = an;
    }
    if (ttsSourceRef.current) {
      try { ttsSourceRef.current.stop(); } catch {}
      ttsSourceRef.current = null;
    }
    const pcm = new Int16Array(arrayBuffer);
    if (pcm.length === 0) return;
    const buffer = ctx.createBuffer(1, pcm.length, sampleRate);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 32768;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ttsAnalyserRef.current);
    src.onended = () => {
      if (ttsSourceRef.current === src) { ttsSourceRef.current = null; setIsAvatarSpeaking(false); }
    };
    ttsSourceRef.current = src;
    setIsAvatarSpeaking(true);
    src.start();
  }

  // Speak Don's reply: route to the live avatar (Avatar view, lip-synced) or
  // through Web Audio so the waveform reacts (Voice view / avatar not ready).
  async function speak(text) {
    const clean = (text || '').trim();
    if (!clean) return;
    let payload;
    try {
      payload = await synthesizeSpeech(clean);
    } catch (err) {
      console.error('TTS error:', err);
      return;
    }
    if (viewModeRef.current === 'avatar' && avatarRef.current?.isReady()) {
      setIsAvatarSpeaking(true);
      avatarRef.current.streamPcm(payload.audioData); // avatar plays + lip-syncs
    } else {
      playPcm(payload.audioData, payload.sampleRate);
    }
  }

  function interruptAll() {
    try { avatarRef.current?.interrupt(); } catch {}
    stopPcm();
  }

  // === SPEECH TO TEXT LOGIC ===
  const stopListening = () => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }
    setIsListening(false);
  };

  const toggleListening = () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      setMicError('Speech recognition is not supported. Please use Chrome or Edge.');
      return;
    }

    // If already listening, stop and send whatever was captured
    if (isListening) {
      recognitionRef.current?.stop();
      return;
    }

    setMicError('');
    transcriptRef.current = '';
    setInput('');
    interruptAll();

    // Request mic permission explicitly first for a clear permission prompt
    navigator.mediaDevices?.getUserMedia({ audio: true })
      .then(() => {
        const recognition = new SpeechRecognition();
        recognitionRef.current = recognition;
        // continuous: true keeps mic open until the user taps stop, which
        // prevents cutting off mid-sentence on natural pauses
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = 'en-US';
        recognition.maxAlternatives = 1;

        recognition.onstart = () => setIsListening(true);

        recognition.onresult = (event) => {
          const transcript = Array.from(event.results)
            .map((r) => r[0].transcript)
            .join('');
          transcriptRef.current = transcript;
          setInput(transcript);
        };

        recognition.onerror = (e) => {
          if (e.error === 'not-allowed') {
            setMicError('Microphone access was denied. Click the lock icon in your browser address bar to allow it.');
          } else if (e.error === 'network') {
            setMicError('Network error. Speech recognition needs an internet connection.');
          } else if (e.error !== 'aborted') {
            setMicError(`Microphone error: ${e.error}`);
          }
          setIsListening(false);
        };

        recognition.onend = () => {
          setIsListening(false);
          recognitionRef.current = null;
          const finalText = transcriptRef.current.trim();
          if (finalText) {
            transcriptRef.current = '';
            // Use a ref-captured version to avoid a stale closure
            sendMsgRef.current(finalText);
          }
        };

        recognition.start();
      })
      .catch(() => {
        setMicError('Microphone access was denied. Click the lock icon in your browser address bar to allow it.');
      });
  };

  // === BUTTON ACTIONS ===
  const stopAvatar = () => {
    stopListening();    // stop mic if active
    interruptAll();     // stop avatar speech / Web Audio playback
  };

  const clearChat = () => {
    stopListening();
    interruptAll();
    setMessages([defaultMessage]);
    setInput('');
    setMicError('');
  };

  // Avatar reports its own speaking state in Avatar view (it owns playback there).
  function handleAvatarStatus(status, detail) {
    if (status === 'speaking') setIsAvatarSpeaking(true);
    else if (status === 'idle') setIsAvatarSpeaking(false);
    else if (status === 'error') {
      setIsAvatarSpeaking(false);
      if (detail) setMessages((prev) => [...prev, { sender: 'bot', text: detail }]);
    }
  }

  // Shared send logic, called by both the button/Enter key and auto-send after speech
  const sendMessageWithText = async (text) => {
    const userMsg = text.trim();
    if (!userMsg) return;

    interruptAll();
    setMessages((prev) => [...prev, { sender: 'user', text: userMsg }]);
    setInput('');
    setIsLoading(true);

    try {
      const response = await fetch('https://azeezo.app.n8n.cloud/webhook/insta', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatInput: userMsg })
      });

      const data = await response.json();
      const chatText  = data.message || data.summary || "I didn't receive a valid response.";
      const speakText = data.summary || chatText;

      setMessages((prev) => [...prev, { sender: 'bot', text: chatText }]);

      // Speak the reply. Errors here are non-fatal; chat still works.
      await speak(speakText);
    } catch (error) {
      console.error('n8n Error:', error);
      setMessages((prev) => [...prev, { sender: 'bot', text: 'Connection to the avatar service failed.' }]);
    } finally {
      setIsLoading(false);
    }
  };

  const sendMessage = () => sendMessageWithText(input);

  // Keep sendMsgRef in sync on every render so onend always calls the latest version
  sendMsgRef.current = sendMessageWithText;

  const waveMode = isListening ? 'listening' : isAvatarSpeaking ? 'speaking' : 'idle';

  return (
    <div className="app-shell">
      <div className="workspace">

        {/* LEFT: AVATAR / VOICE PANEL */}
        <aside className="av-panel">
          <header className="av-header">
            <div className="av-logo-wrap">
              <img src="/jada-logo.png" alt="JADA" className="av-logo" />
            </div>
            <div className={`av-status ${isListening ? 'av-status--listening' : isAvatarSpeaking ? 'av-status--speaking' : ''}`}>
              <span className="av-status__dot" />
              {isListening ? 'Listening' : isAvatarSpeaking ? 'Speaking' : 'Ready'}
            </div>
          </header>

          <div className="av-scene">
            <div className="view-toggle" role="tablist" aria-label="Avatar or voice view">
              <button
                role="tab"
                aria-selected={viewMode === 'avatar'}
                className={`view-toggle__btn ${viewMode === 'avatar' ? 'view-toggle__btn--active' : ''}`}
                onClick={() => setViewMode('avatar')}
              >
                Avatar
              </button>
              <button
                role="tab"
                aria-selected={viewMode === 'voice'}
                className={`view-toggle__btn ${viewMode === 'voice' ? 'view-toggle__btn--active' : ''}`}
                onClick={() => setViewMode('voice')}
              >
                Voice
              </button>
            </div>

            {viewMode === 'avatar' ? (
              <SpatiusAvatar ref={avatarRef} onStatus={handleAvatarStatus} />
            ) : (
              <VoiceWave
                micAnalyserRef={micAnalyserRef}
                ttsAnalyserRef={ttsAnalyserRef}
                mode={waveMode}
              />
            )}
          </div>

          {micError && (
            <div className="mic-error">{micError}</div>
          )}

          <div className="av-controls">
            <button
              className={`btn-talk ${isListening ? 'btn-talk--active' : ''}`}
              onClick={toggleListening}
            >
              <MicIcon />
              <span>{isListening ? 'Tap to stop' : 'Talk to Don'}</span>
            </button>
            <button className="btn-round" onClick={stopAvatar} title="Stop speaking">
              <StopIcon />
            </button>
            <button className="btn-round" onClick={clearChat} title="New conversation">
              <ResetIcon />
            </button>
          </div>
        </aside>

        {/* RIGHT: CHAT PANEL */}
        <main className="chat-panel">
          <header className="chat-header">
            <div className="chat-header__av">D</div>
            <div className="chat-header__info">
              <span className="chat-header__name">Don</span>
              <span className="chat-header__sub">
                <span className="online-dot" />
                AI Analytics Assistant
              </span>
            </div>
            <button className="btn-chat-clear" onClick={clearChat}>Clear chat</button>
          </header>

          <div className="chat-messages">
            {messages.map((msg, idx) => {
              const isUser = msg.sender === 'user';
              return (
                <div key={idx} className={`msg-row ${isUser ? 'msg-row--user' : 'msg-row--bot'}`}>
                  {!isUser && <div className="msg-av">D</div>}
                  <div className={`msg-bubble ${isUser ? 'msg-bubble--user' : 'msg-bubble--bot'}`}>
                    {isUser ? msg.text : <ReactMarkdown>{msg.text}</ReactMarkdown>}
                  </div>
                </div>
              );
            })}
            {isLoading && (
              <div className="msg-row msg-row--bot">
                <div className="msg-av">D</div>
                <div className="msg-bubble msg-bubble--bot msg-bubble--typing">
                  <span className="typing-dot" style={{ animationDelay: '0ms' }} />
                  <span className="typing-dot" style={{ animationDelay: '160ms' }} />
                  <span className="typing-dot" style={{ animationDelay: '320ms' }} />
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          <div className="chat-input-row">
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !isLoading && sendMessage()}
              placeholder="Type a message..."
              className="chat-input"
            />
            <button
              onClick={sendMessage}
              disabled={isLoading || !input.trim()}
              className="btn-send"
            >
              <SendIcon />
              <span>Send</span>
            </button>
          </div>
        </main>

      </div>
    </div>
  );
}
