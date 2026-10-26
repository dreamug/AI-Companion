"""Offline ASR worker: audio enters stdin; only bounded JSON leaves stdout."""
import json
import os
import subprocess
import sys

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"

def main():
    model, ffmpeg = sys.argv[1:3]
    audio = sys.stdin.buffer.read(4 * 1024 * 1024 + 1)
    if not audio or len(audio) > 4 * 1024 * 1024:
        return 2
    # Limit decoded duration/memory even for a crafted compressed recording.
    decoded = subprocess.run([
        ffmpeg, "-nostdin", "-v", "error", "-threads", "1", "-i", "pipe:0",
        "-t", "63", "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "pipe:1"
    ], input=audio, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=12)
    del audio
    if decoded.returncode or not decoded.stdout or len(decoded.stdout) % 4:
        return 2
    duration = len(decoded.stdout) / (16000 * 4)
    if duration > 62:
        return 3
    import numpy as np
    import mlx_whisper
    pcm = np.frombuffer(decoded.stdout, dtype=np.float32).copy()
    # Silence must not trigger Whisper's occasional hallucinated outro text.
    if float(np.sqrt(np.mean(pcm ** 2))) < 0.002:
        text = ""
    else:
        result = mlx_whisper.transcribe(
            pcm, path_or_hf_repo=model, language="zh", task="transcribe",
            verbose=None, temperature=0, condition_on_previous_text=False,
            initial_prompt="以下是简体中文的日常对话。角色名字：小野、小棠。",
        )
        text = "".join(s["text"] for s in result["segments"]
                       if s.get("no_speech_prob", 0) < 0.6).strip()
    print(json.dumps({"text": text, "duration": duration}, ensure_ascii=False))
    return 0

if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        # Never print audio, transcript, config or a raw traceback to logs.
        sys.exit(1)
