import React, { Suspense, useEffect, useState, useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, useGLTF, Environment } from '@react-three/drei';
import * as THREE from 'three';
import * as SpeechSDK from 'microsoft-cognitiveservices-speech-sdk';
import ReactMarkdown from 'react-markdown';
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

// Azure viseme IDs (0-21) mapped to the Oculus / Ready Player Me viseme blend
// shapes that josh.glb exposes (CH DD E FF PP RR SS TH aa ih kk nn oh ou sil).
// Every Azure viseme gets a phonetically correct shape; the old mapping wrongly
// collapsed s/z to silence and folded sh/ch/th/r into the wrong shapes.
const AZURE_VISEME_TO_OCULUS = {
  0:  'sil', //          silence
  1:  'aa',  // ae uh    bat, the, but
  2:  'aa',  // ah       father
  3:  'oh',  // aw       thought
  4:  'E',   // eh oo    bed, book
  5:  'RR',  // er       bird (r-coloured)
  6:  'ih',  // y i ih   yes, ease, it
  7:  'ou',  // w u      we, you
  8:  'oh',  // oh       go
  9:  'aa',  // ow       how
  10: 'oh',  // oy       boy
  11: 'aa',  // eye      my
  12: 'aa',  // h        he
  13: 'RR',  // r        red
  14: 'nn',  // l        let
  15: 'SS',  // s z      see, zoo   (was wrongly 'sil')
  16: 'CH',  // sh ch j  she, church, judge
  17: 'TH',  // th       then
  18: 'FF',  // f v      for, very
  19: 'DD',  // d t n    dig, top, no
  20: 'kk',  // k g ng   cat, go, sing
  21: 'PP',  // p b m    put, big, my
};

// Every viseme morph we drive, so the inactive ones relax toward 0 each frame.
// 'sil' is omitted on purpose: silence means rest pose, which for a normal face
// mesh is already a closed mouth, so we just let everything fall to 0.
const ALL_VISEMES = ['CH', 'DD', 'E', 'FF', 'PP', 'RR', 'SS', 'TH', 'aa', 'ih', 'kk', 'nn', 'oh', 'ou'];

// Lip-sync tuning (seconds)
const VISEME_LEAD = 0.04;   // let mouth shapes lead the audio a hair
const VISEME_BLEND = 0.07;  // crossfade window between consecutive visemes
const SMOOTH_TAU = 0.025;   // exponential-smoothing time constant (frame-rate independent)

// Call Azure TTS and collect viseme events alongside the audio ArrayBuffer.
// audioOffset is in 100-nanosecond ticks, so divide by 10,000,000 for seconds.
async function synthesizeSpeech(text) {
  // Fetch a short-lived token from our server - the actual key stays server-side
  const tokenRes = await fetch('/api/speech-token');
  if (!tokenRes.ok) throw new Error('Could not obtain speech token from server.');
  const { token, region } = await tokenRes.json();

  return new Promise((resolve, reject) => {
    const speechConfig = SpeechSDK.SpeechConfig.fromAuthorizationToken(token, region);
    speechConfig.speechSynthesisVoiceName = 'en-US-AndrewNeural';
    // null audioConfig means the SDK returns full audio as ArrayBuffer in result.audioData
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

// Audio is owned at the App level (not inside the 3D avatar) so it plays in both
// the avatar and the voice-orb views. This hook owns the AudioContext, plays each
// TTS clip, and taps the signal with an AnalyserNode the orb reads for its pulse.
// The avatar's viseme loop reads startTimeRef/playingRef for timing.
function useSpeechAudio(ttsPayload, onEnded) {
  const audioCtxRef  = useRef(null);
  const analyserRef  = useRef(null);
  const sourceRef    = useRef(null);
  const startTimeRef = useRef(0);
  const playingRef   = useRef(false);
  const onEndedRef   = useRef(onEnded);
  onEndedRef.current = onEnded;

  useEffect(() => {
    // Stop whatever is currently playing
    if (sourceRef.current) { try { sourceRef.current.stop(); } catch {} sourceRef.current = null; }
    playingRef.current = false;
    if (!ttsPayload) return;

    let cancelled = false;
    const ctx = audioCtxRef.current || (audioCtxRef.current = new AudioContext());
    ctx.resume?.();
    // One analyser for the whole session, sitting between source and speakers
    if (!analyserRef.current) {
      const an = ctx.createAnalyser();
      an.fftSize = 1024;
      an.smoothingTimeConstant = 0.82;
      an.connect(ctx.destination);
      analyserRef.current = an;
    }
    // slice(0) copies the ArrayBuffer before decodeAudioData detaches it
    ctx.decodeAudioData(ttsPayload.audioData.slice(0))
      .then((buffer) => {
        if (cancelled) return;
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(analyserRef.current);
        startTimeRef.current = ctx.currentTime;
        src.start(0);
        sourceRef.current = src;
        playingRef.current = true;
        src.onended = () => {
          if (cancelled) return;
          sourceRef.current = null;
          playingRef.current = false;
          onEndedRef.current?.();
        };
      })
      .catch(console.error);

    return () => {
      cancelled = true;
      if (sourceRef.current) { try { sourceRef.current.stop(); } catch {} sourceRef.current = null; }
      playingRef.current = false;
    };
  }, [ttsPayload]);

  return { audioCtxRef, analyserRef, startTimeRef, playingRef };
}

// Taps the microphone into an analyser while active, so the orb reacts to the
// user's voice the way ChatGPT's does. Reuses the shared AudioContext and never
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
        const ctx = audioCtxRef.current || (audioCtxRef.current = new AudioContext());
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

// ChatGPT-style voice orb: a soft, cloudy blue-white sphere that breathes when
// idle and swells/glows with the live audio level (assistant speech, or the
// user's mic while listening). All motion is CSS; this only feeds a smoothed
// amplitude into the --amp custom property each animation frame.
const ORB_FFT = 1024;
function VoiceOrb({ ttsAnalyserRef, micAnalyserRef, isSpeaking, isListening }) {
  const orbRef = useRef(null);
  const ampRef = useRef(0);

  useEffect(() => {
    let raf;
    const buf = new Uint8Array(ORB_FFT);
    const tick = () => {
      const analyser = isSpeaking ? ttsAnalyserRef.current
                     : isListening ? micAnalyserRef.current
                     : null;
      let target = 0;
      if (analyser) {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
        target = Math.min(1, Math.sqrt(sum / buf.length) * 3.2);
      }
      // Fast attack, slow release - lively without flicker
      const cur = ampRef.current;
      ampRef.current = cur + (target - cur) * (target > cur ? 0.35 : 0.08);
      orbRef.current?.style.setProperty('--amp', ampRef.current.toFixed(3));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isSpeaking, isListening, ttsAnalyserRef, micAnalyserRef]);

  return (
    <div className="orb-stage">
      <div
        ref={orbRef}
        className={`orb ${isSpeaking ? 'orb--speaking' : ''} ${isListening ? 'orb--listening' : ''}`}
        style={{ '--amp': 0 }}
      >
        <div className="orb__glow" />
        <div className="orb__core">
          <div className="orb__cloud orb__cloud--a" />
          <div className="orb__cloud orb__cloud--b" />
          <div className="orb__cloud orb__cloud--c" />
          <div className="orb__sheen" />
        </div>
      </div>
    </div>
  );
}

function TalkingAvatar({ visemes, audioCtxRef, startTimeRef, playingRef }) {
  const { scene } = useGLTF('/avatars/josh.glb');
  const faceMeshes = useRef([]);
  const visemesRef = useRef([]);
  const blinkRef   = useRef({ next: 2 + Math.random() * 3, t: -1 });

  useEffect(() => {
    faceMeshes.current = [];
    scene.traverse((child) => {
      if (child.isMesh && child.morphTargetDictionary) faceMeshes.current.push(child);
      if (child.isBone) {
        if (child.name.includes('LeftShoulder')) child.rotation.z = 0.2;
        if (child.name.includes('RightShoulder')) child.rotation.z = -0.2;
        if (child.name === 'LeftArm')  child.rotation.x = 1.2;
        if (child.name === 'RightArm') child.rotation.x = 1.2;
      }
    });
  }, [scene]);

  // Mirror the active viseme track into a ref for the render loop. Audio playback
  // lives in the parent (useSpeechAudio) so speech keeps playing regardless of
  // which view (avatar or orb) is mounted.
  useEffect(() => { visemesRef.current = visemes ?? []; }, [visemes]);

  useFrame((_state, delta) => {
    const meshes = faceMeshes.current;
    if (meshes.length === 0) return;
    const dt = Math.min(delta, 0.1); // clamp big gaps (e.g. backgrounded tab)

    // 1. Resolve viseme targets via a time-based crossfade between keyframes
    const targets = {}; // viseme name -> target weight (0..1)
    const ctx = audioCtxRef.current;
    const visemes = visemesRef.current;
    if (ctx && playingRef.current && visemes.length > 0) {
      const elapsed = ctx.currentTime - startTimeRef.current + VISEME_LEAD;
      let i = -1;
      for (let k = 0; k < visemes.length; k++) {
        if (visemes[k].timeSeconds <= elapsed) i = k; else break;
      }
      if (i >= 0) {
        const cur = AZURE_VISEME_TO_OCULUS[visemes[i].visemeId] ?? 'sil';
        const nextV = visemes[i + 1];
        const next = nextV ? (AZURE_VISEME_TO_OCULUS[nextV.visemeId] ?? 'sil') : 'sil';
        const segStart = visemes[i].timeSeconds;
        const segEnd = nextV ? nextV.timeSeconds : segStart + 0.18;
        const blend = Math.min(VISEME_BLEND, (segEnd - segStart) * 0.5);
        let wNext = 0;
        if (blend > 0 && elapsed > segEnd - blend) {
          wNext = (elapsed - (segEnd - blend)) / blend; // 0 -> 1 into the next shape
        }
        const wCur = 1 - wNext;
        if (cur !== 'sil') targets[cur] = (targets[cur] || 0) + wCur;
        if (next !== 'sil') targets[next] = (targets[next] || 0) + wNext;
      }
    }

    // 2. Idle eye blink (randomized, smooth sine envelope)
    const blink = blinkRef.current;
    let blinkW = 0;
    if (blink.t >= 0) {
      blink.t += dt;
      const DUR = 0.14;
      if (blink.t >= DUR) { blink.t = -1; blink.next = 2.5 + Math.random() * 3.5; }
      else blinkW = Math.sin((blink.t / DUR) * Math.PI); // 0 -> 1 -> 0
    } else {
      blink.next -= dt;
      if (blink.next <= 0) blink.t = 0;
    }

    // 3. Apply to every face mesh with frame-rate-independent smoothing
    const k = 1 - Math.exp(-dt / SMOOTH_TAU);
    meshes.forEach((mesh) => {
      const dict = mesh.morphTargetDictionary;
      const infl = mesh.morphTargetInfluences;
      ALL_VISEMES.forEach((name) => {
        const idx = dict[name];
        if (idx !== undefined) {
          infl[idx] = THREE.MathUtils.lerp(infl[idx], targets[name] || 0, k);
        }
      });
      // Blink is already a smooth envelope, so set it directly.
      const bl = dict.eyeBlinkLeft, br = dict.eyeBlinkRight;
      if (bl !== undefined) infl[bl] = blinkW;
      if (br !== undefined) infl[br] = blinkW;
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
  const [viewMode, setViewMode] = useState('voice'); // 'avatar' | 'voice'
  const recognitionRef = useRef(null);
  const transcriptRef = useRef('');
  const messagesEndRef = useRef(null);

  // Audio is owned here (not inside the 3D avatar) so speech plays in either view
  // and both the avatar (visemes) and the orb (amplitude) can read it.
  const { audioCtxRef, analyserRef, startTimeRef, playingRef } =
    useSpeechAudio(ttsPayload, () => setIsAvatarSpeaking(false));
  const micAnalyserRef = useMicAudio(isListening, audioCtxRef);

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

    // If already listening, stop and send whatever was captured
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

  // Keep a stable ref to sendMessageWithText so recognition.onend never has a stale closure
  const sendMsgRef = useRef(null);

  // === BUTTON ACTIONS ===
  const stopAvatar = () => {
    stopListening();          // stop mic if active
    setIsAvatarSpeaking(false);
    setTtsPayload(null);      // stops playback inside useSpeechAudio
  };

  const clearChat = () => {
    stopListening();
    setMessages([defaultMessage]);
    setInput('');
    setMicError('');
    setIsAvatarSpeaking(false);
    setTtsPayload(null);
  };

  // Shared send logic, called by both the button/Enter key and auto-send after speech
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

      // Synthesize speech. Errors here are non-fatal; chat still works
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
            {viewMode === 'avatar' && isAvatarSpeaking && <div className="av-glow" />}

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
              <Canvas camera={{ position: [0, 0.1, 2.8], fov: 20 }}>
                <ambientLight intensity={0.7} />
                <directionalLight position={[0, 2, 3]} intensity={0.8} />
                <Environment preset="city" />
                <Suspense fallback={null}>
                  <TalkingAvatar
                    visemes={ttsPayload?.visemes}
                    audioCtxRef={audioCtxRef}
                    startTimeRef={startTimeRef}
                    playingRef={playingRef}
                  />
                </Suspense>
                <OrbitControls enableZoom={false} enablePan={false} enableRotate={false} target={[0, 0.05, 0]} />
              </Canvas>
            ) : (
              <VoiceOrb
                ttsAnalyserRef={analyserRef}
                micAnalyserRef={micAnalyserRef}
                isSpeaking={isAvatarSpeaking}
                isListening={isListening}
              />
            )}
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
