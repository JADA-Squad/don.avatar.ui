import { useEffect, useRef } from "react";

// A live audio visualizer: a centered row of bars that react to an AnalyserNode.
// Drives off the mic while listening and the assistant's speech while speaking;
// when idle it shows a calm breathing wave. This replaces the old ChatGPT orb.
const BARS = 48;

export default function VoiceWave({ micAnalyserRef, ttsAnalyserRef, mode }) {
  const canvasRef = useRef(null);
  const heightsRef = useRef(new Array(BARS).fill(0.05));
  const phaseRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    let raf;
    let freq = new Uint8Array(2048);

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.clientWidth || 1;
      const h = canvas.clientHeight || 1;
      const pw = Math.round(w * dpr);
      const ph = Math.round(h * dpr);
      if (canvas.width !== pw || canvas.height !== ph) {
        canvas.width = pw;
        canvas.height = ph;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);

      const analyser = mode === "listening" ? (micAnalyserRef && micAnalyserRef.current)
                     : mode === "speaking" ? (ttsAnalyserRef && ttsAnalyserRef.current)
                     : null;
      phaseRef.current += 0.045;

      if (analyser) {
        if (freq.length !== analyser.frequencyBinCount) {
          freq = new Uint8Array(analyser.frequencyBinCount);
        }
        analyser.getByteFrequencyData(freq);
      }

      // Color by mode: orange for the mic, blue for the assistant, dim when idle.
      let stroke;
      if (mode === "listening") stroke = "#e85e09";
      else if (mode === "speaking") stroke = "#56a8f5";
      else stroke = "rgba(180, 210, 255, 0.35)";

      const gap = 3;
      const barW = Math.max(2, (w - (BARS - 1) * gap) / BARS);
      const mid = h / 2;
      const heights = heightsRef.current;
      const useRound = typeof ctx.roundRect === "function";

      ctx.fillStyle = stroke;
      ctx.shadowColor = stroke;
      ctx.shadowBlur = mode === "idle" ? 0 : 10;

      for (let i = 0; i < BARS; i++) {
        let target;
        if (analyser) {
          // Speech energy sits in the lower part of the spectrum; spread the
          // first ~60% of bins across the bars and shape the ends down a touch.
          const idx = Math.floor((i / BARS) * freq.length * 0.6);
          const edge = Math.sin((i / (BARS - 1)) * Math.PI); // 0..1..0
          target = (freq[idx] / 255) * (0.35 + 0.65 * edge);
        } else {
          target = 0.05 + 0.04 * (0.5 + 0.5 * Math.sin(phaseRef.current + i * 0.35));
        }
        heights[i] += (target - heights[i]) * 0.3;
        const bh = Math.max(2, heights[i] * (h * 0.92));
        const x = i * (barW + gap);
        const y = mid - bh / 2;
        ctx.beginPath();
        if (useRound) ctx.roundRect(x, y, barW, bh, Math.min(barW / 2, 3));
        else ctx.rect(x, y, barW, bh);
        ctx.fill();
      }
      ctx.shadowBlur = 0;

      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [micAnalyserRef, ttsAnalyserRef, mode]);

  return (
    <div className={`voice-wave voice-wave--${mode}`}>
      <canvas ref={canvasRef} className="voice-wave__canvas" />
    </div>
  );
}
