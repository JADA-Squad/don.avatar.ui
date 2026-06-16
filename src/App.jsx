import React, { Suspense, useEffect, useState, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, useGLTF, Environment } from '@react-three/drei';
import * as THREE from 'three';
import ReactMarkdown from 'react-markdown';
import './App.css';

// Kick off the 23 MB GLB download immediately when this module is parsed,
// long before the Canvas or TalkingAvatar component mounts.
useGLTF.preload('/avatars/josh.glb');

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

// Azure viseme IDs (0-21) → Ready Player Me blend shape names
const AZURE_VISEME_TO_RPM = {
  0:  'sil',  // silence
  1:  'aa',   // æ ə ʌ
  2:  'aa',   // aa
  3:  'oh',   // ɔ
  4:  'ih',   // ɛ ʊ
  5:  'ih',   // ɝ
  6:  'ih',   // j i ɪ
  7:  'ou',   // w u
  8:  'oh',   // o
  9:  'aa',   // aʊ
  10: 'oh',   // ɔɪ
  11: 'aa',   // aɪ
  12: 'nn',   // h
  13: 'nn',   // ɹ
  14: 'nn',   // l
  15: 'sil',  // s z
  16: 'ih',   // ʃ tʃ dʒ ʒ
  17: 'FF',   // ð (dental → FF closest)
  18: 'FF',   // f v
  19: 'nn',   // d t n
  20: 'kk',   // k g ŋ
  21: 'PP',   // p b m
};

const ALL_RPM_VISEMES = ['PP', 'kk', 'ih', 'aa', 'oh', 'ou', 'FF', 'nn', 'sil'];

// Call Azure TTS and collect viseme events alongside the audio ArrayBuffer.
// audioOffset is in 100-nanosecond ticks → divide by 10,000,000 for seconds.
async function synthesizeSpeech(text) {
  // Fetch a short-lived token from our server — the actual key stays server-side
  const tokenRes = await fetch('/api/speech-token');
  if (!tokenRes.ok) throw new Error('Could not obtain speech token from server.');
  const { token, region } = await tokenRes.json();

  // Lazy-load the SDK — only fetched on first TTS call, not on page load
  const SpeechSDK = await import('microsoft-cognitiveservices-speech-sdk');

  return new Promise((resolve, reject) => {
    const speechConfig = SpeechSDK.SpeechConfig.fromAuthorizationToken(token, region);
    speechConfig.speechSynthesisVoiceName = 'en-US-AndrewNeural';
    // null audioConfig → SDK returns full audio as ArrayBuffer in result.audioData
    const synthesizer = new SpeechSDK.SpeechSynthesizer(speechConfig, null);
    const visemes = [];
    synthesizer.visemeReceived = (_s, e) => {
      visemes.push({ timeSeconds: e.audioOffset / 10_000_000, visemeId: e.visemeId });
    };
    synthesizer.speakTextAsync(
      text,
      (result) => {
        synthesizer.close();
        if (result.reason === SpeechSDK.ResultReason.SynthesizingAudioCompleted) {
          resolve({ audioData: result.audioData, visemes });
        } else {
          reject(new Error(result.errorDetails || 'TTS synthesis failed'));
        }
      },
      (err) => { synthesizer.close(); reject(new Error(err)); }
    );
  });
}

function TalkingAvatar({ ttsPayload, onEnded, onLoad }) {
  const { scene } = useGLTF('/avatars/josh.glb');
  const faceMeshes    = useRef([]);
  const audioCtxRef   = useRef(null);
  const sourceRef     = useRef(null);
  const startTimeRef  = useRef(0);
  const visemesRef    = useRef([]);

  useEffect(() => {
    scene.traverse((child) => {
      if (child.isMesh && child.morphTargetDictionary) faceMeshes.current.push(child);
      if (child.isBone) {
        if (child.name.includes('LeftShoulder')) child.rotation.z = 0.2;
        if (child.name.includes('RightShoulder')) child.rotation.z = -0.2;
        if (child.name === 'LeftArm')  child.rotation.x = 1.2;
        if (child.name === 'RightArm') child.rotation.x = 1.2;
      }
    });
    // Signal to parent that the model has finished parsing and is ready
    onLoad?.();
  }, [scene]);

  useEffect(() => {
    // Stop any currently playing audio
    if (sourceRef.current) {
      try { sourceRef.current.stop(); } catch {}
      sourceRef.current = null;
    }
    if (!ttsPayload) {
      visemesRef.current = [];
      return;
    }
    let cancelled = false;
    const { audioData, visemes } = ttsPayload;
    visemesRef.current = visemes;
    const ctx = audioCtxRef.current || (audioCtxRef.current = new AudioContext());
    // slice(0) copies the ArrayBuffer before decodeAudioData detaches it
    ctx.decodeAudioData(audioData.slice(0))
      .then((buffer) => {
        if (cancelled) return;
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        startTimeRef.current = ctx.currentTime;
        source.start(0);
        sourceRef.current = source;
        source.onended = () => {
          if (!cancelled) { sourceRef.current = null; onEnded?.(); }
        };
      })
      .catch(console.error);
    return () => {
      cancelled = true;
      if (sourceRef.current) {
        try { sourceRef.current.stop(); } catch {}
        sourceRef.current = null;
      }
    };
  }, [ttsPayload]);

  useFrame(() => {
    if (faceMeshes.current.length === 0) return;
    let targetBlendshape = 'sil';
    const ctx = audioCtxRef.current;
    if (ctx && sourceRef.current && visemesRef.current.length > 0) {
      const elapsed = ctx.currentTime - startTimeRef.current;
      // Find the last viseme whose start time has passed
      let active = null;
      for (const v of visemesRef.current) {
        if (v.timeSeconds <= elapsed) active = v; else break;
      }
      if (active) targetBlendshape = AZURE_VISEME_TO_RPM[active.visemeId] ?? 'sil';
    }
    faceMeshes.current.forEach((mesh) => {
      const morphDict  = mesh.morphTargetDictionary;
      const morphArray = mesh.morphTargetInfluences;
      ALL_RPM_VISEMES.forEach((visemeName) => {
        const idx = morphDict[visemeName];
        if (idx !== undefined) {
          morphArray[idx] = THREE.MathUtils.lerp(
            morphArray[idx],
            visemeName === targetBlendshape ? 1 : 0,
            0.25
          );
        }
      });
    });
  });

  return <primitive object={scene} scale={2} position={[0, -3.2, 0]} />;
}

export default function App() {
  const defaultMessage = { sender: 'bot', text: 'Hey! I\'m Don, your AI analytics assistant. Talk or type - I\'m ready when you are.' };
  const [messages, setMessages] = useState([defaultMessage]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isAvatarSpeaking, setIsAvatarSpeaking] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [ttsPayload, setTtsPayload] = useState(null); // { audioData, visemes }
  const [micError, setMicError] = useState('');
  const [isSceneLoaded, setIsSceneLoaded] = useState(false);
  const recognitionRef = useRef(null);
  const transcriptRef = useRef('');
  const messagesEndRef = useRef(null);

  // Auto-scroll chat to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

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

    // If already listening — stop and send whatever was captured
    if (isListening) {
      recognitionRef.current?.stop();
      return;
    }

    setMicError('');
    transcriptRef.current = '';
    setInput('');

    // Request mic permission explicitly first for a clear permission prompt
    navigator.mediaDevices?.getUserMedia({ audio: true })
      .then(() => {
        const recognition = new SpeechRecognition();
        recognitionRef.current = recognition;
        // continuous: true keeps mic open until the user taps stop —
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
            setMicError('Network error — speech recognition needs an internet connection.');
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
            // Use a ref-captured version to avoid stale closure
            sendMsgRef.current(finalText);
          }
        };

        recognition.start();
      })
      .catch(() => {
        setMicError('Microphone access was denied. Click the lock icon in your browser address bar to allow it.');
      });
  };

  // Keep a stable ref to sendMessageWithText so recognition.onend never has a stale closure
  const sendMsgRef = useRef(null);

  // === BUTTON ACTIONS ===
  const stopAvatar = () => {
    stopListening();          // stop mic if active
    setIsAvatarSpeaking(false);
    setTtsPayload(null);      // stops AudioContext playback inside TalkingAvatar
  };

  const clearChat = () => {
    stopListening();
    setMessages([defaultMessage]);
    setInput('');
    setMicError('');
    setIsAvatarSpeaking(false);
    setTtsPayload(null);
  };

  // Shared send logic — called by both the button/Enter key and auto-send after speech
  const sendMessageWithText = async (text) => {
    const userMsg = text.trim();
    if (!userMsg) return;

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

      // Synthesize speech — errors here are non-fatal; chat still works
      try {
        const payload = await synthesizeSpeech(speakText);
        setTtsPayload(payload);
        setIsAvatarSpeaking(true);
      } catch (ttsErr) {
        console.error('TTS error:', ttsErr);
      }

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

  return (
    <div className="app-shell">
      <div className="workspace">

        {/* ── LEFT: AVATAR PANEL ── */}
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
            {isAvatarSpeaking && <div className="av-glow" />}
            {!isSceneLoaded && (
              <div className="av-loading">
                <div className="av-loading__spinner" />
                <span>Loading avatar…</span>
              </div>
            )}
            <Canvas camera={{ position: [0, 0.1, 2.8], fov: 20 }}>
              <ambientLight intensity={0.7} />
              <directionalLight position={[0, 2, 3]} intensity={0.8} />
              <Environment preset="city" />
              <Suspense fallback={null}>
                <TalkingAvatar
                  ttsPayload={ttsPayload}
                  onEnded={() => setIsAvatarSpeaking(false)}
                  onLoad={() => setIsSceneLoaded(true)}
                />
              </Suspense>
              <OrbitControls enableZoom={false} enablePan={false} enableRotate={false} target={[0, 0.05, 0]} />
            </Canvas>
          </div>

          {micError && (
            <div className="mic-error">{micError}</div>
          )}

          <div className="av-waveform">
            {[...Array(9)].map((_, i) => (
              <div
                key={i}
                className={`av-bar ${isListening ? 'av-bar--active' : ''}`}
                style={isListening ? {
                  animationDelay: `${i * 55}ms`,
                  animationDuration: `${460 + (i % 4) * 105}ms`
                } : {}}
              />
            ))}
          </div>

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

        {/* ── RIGHT: CHAT PANEL ── */}
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